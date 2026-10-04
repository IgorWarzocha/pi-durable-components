// Adapted from pi-codex-conversion at b2006db9def12c373ae48e70044d30f7d6b7e34f, MIT. See ../NOTICE.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DenoJupyterKernel } from "./jupyter-kernel.ts";
import { commitProjectStateCandidate } from "./project-state-commit.ts";
import { listProjectConflicts } from "./project-state-conflicts.ts";
import {
	projectStatePaths,
	readProjectStateCandidate,
	readProjectStateManifest,
	readProjectStatePayload,
} from "./project-state-files.ts";
import {
	baselineFromProjectManifest,
	emptyProjectStateSummary,
	MAX_PROJECT_ENTRIES,
	MAX_PROJECT_NAME_BYTES,
	type ProjectStateBaseline,
	type ProjectStateSummary,
} from "./project-state-format.ts";
import { withProjectStateLock } from "./project-state-lock.ts";
import type { ProjectStatePinUpdate } from "./project-state-merge.ts";
import {
	parseProjectBindingNames,
	projectBindingNamesSource,
	projectStateCaptureSource,
	projectStateRestoreSource,
	promoteProjectBindingsSource,
	syncProjectBindingsSource,
} from "./project-state-runtime.ts";

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export type {
	ProjectStateBaseline,
	ProjectStateSummary,
} from "./project-state-format.ts";

export async function restoreProjectState(
	kernel: DenoJupyterKernel,
	identity: {
		project: string;
		agentDir: string;
		maxBytes: number;
		signal?: AbortSignal | undefined;
	},
): Promise<ProjectStateSummary> {
	const paths = projectStatePaths(identity.project, identity.agentDir);
	mkdirSync(paths.directory, { recursive: true });
	return withProjectStateLock(
		paths.lock,
		() => restoreProjectStateLocked(kernel, identity, paths),
		identity.signal,
	);
}

async function restoreProjectStateLocked(
	kernel: DenoJupyterKernel,
	identity: {
		project: string;
		maxBytes: number;
		signal?: AbortSignal | undefined;
	},
	paths: ReturnType<typeof projectStatePaths>,
): Promise<ProjectStateSummary> {
	identity.signal?.throwIfAborted();
	const manifest = readProjectStateManifest(paths.manifest);
	if (!manifest) return emptyProjectStateSummary();
	if (manifest.project !== resolve(identity.project)) {
		return {
			...emptyProjectStateSummary(),
			message:
				"Project notebook identity was incompatible and was not restored",
		};
	}
	const payloadPath = join(paths.directory, manifest.payload);
	const hookNames = manifest.entries
		.filter((entry) => entry.hook)
		.map((entry) => entry.name);
	if (!readProjectStatePayload(manifest, payloadPath, identity.maxBytes)) {
		if (hookNames.length > 0)
			throw new Error(
				`Project notebook payload was missing or invalid; hooks could not be restored. To unpin them, call notebook with ${JSON.stringify({ input: JSON.stringify({ action: "unpin", names: hookNames }) })}`,
			);
		return {
			...emptyProjectStateSummary(),
			message:
				"Project notebook payload was missing or invalid and was not restored",
		};
	}
	identity.signal?.throwIfAborted();
	const result = await kernel.execute(
		projectStateRestoreSource(manifest, payloadPath),
		{ signal: identity.signal },
	);
	if (result.status !== "ok") {
		if (hookNames.length > 0) {
			throw new Error(
				`Project notebook hooks could not be restored: ${result.errorText ?? "unknown error"}. To unpin them, call notebook with ${JSON.stringify({ input: JSON.stringify({ action: "unpin", names: hookNames }) })}`,
			);
		}
		return {
			...emptyProjectStateSummary(),
			message: `Project notebook was incompatible and was not restored: ${result.errorText ?? "unknown error"}`,
		};
	}
	return {
		baseline: baselineFromProjectManifest(manifest),
		restored: manifest.entries,
		skipped: manifest.skipped,
		conflicts: listProjectConflicts(paths.directory),
	};
}

export async function writeProjectState(
	kernel: DenoJupyterKernel,
	identity: { project: string; session: string; agentDir: string },
	baseline: ProjectStateBaseline,
	baselineNames: ReadonlySet<string>,
	maxBytes: number,
	excludeNames: ReadonlySet<string> = new Set(),
	pins?: ProjectStatePinUpdate | undefined,
): Promise<ProjectStateSummary> {
	const paths = projectStatePaths(identity.project, identity.agentDir);
	mkdirSync(paths.directory, { recursive: true });
	const candidateId = randomUUID();
	const candidatePayloadPath = join(
		paths.directory,
		`candidate-${candidateId}.bin`,
	);
	const candidateManifestPath = join(
		paths.directory,
		`candidate-${candidateId}.json`,
	);
	try {
		const marker = `__PI_NOTEBOOK_PROJECT_BINDINGS_${randomUUID()}__`;
		const selected = parseProjectBindingNames(
			await kernel.execute(projectBindingNamesSource(marker)),
			marker,
		);
		const available = new Set(await kernel.complete("", 0));
		const names = selected
			.filter(
				(name) =>
					available.has(name) &&
					!baselineNames.has(name) &&
					!excludeNames.has(name) &&
					IDENTIFIER.test(name),
			)
			.sort();
		if (names.length > MAX_PROJECT_ENTRIES)
			throw new Error(
				`Project notebook state exceeds ${MAX_PROJECT_ENTRIES} top-level values`,
			);
		if (
			names.some((name) => Buffer.byteLength(name) > MAX_PROJECT_NAME_BYTES)
		) {
			throw new Error(
				`Project notebook name exceeds ${MAX_PROJECT_NAME_BYTES} bytes`,
			);
		}
		const capture = await kernel.execute(
			projectStateCaptureSource({
				candidates: names,
				payloadPath: candidatePayloadPath,
				manifestPath: candidateManifestPath,
				maxBytes,
			}),
		);
		if (capture.status !== "ok")
			throw new Error(
				`Project notebook checkpoint failed: ${capture.errorText ?? "unknown error"}`,
			);
		const candidate = readProjectStateCandidate(
			candidateManifestPath,
			candidatePayloadPath,
			maxBytes,
		);
		if (!candidate)
			throw new Error(
				"Project notebook checkpoint did not produce a valid candidate",
			);
		const candidatePayload = readFileSync(candidatePayloadPath);
		const committed = await commitProjectStateCandidate({
			paths,
			identity,
			baseline,
			candidate,
			candidatePayload,
			maxBytes,
			pins,
		});
		const committedNames = [
			...new Set([
				...(committed.manifest?.entries.map(({ name }) => name) ?? []),
				...candidate.skipped.map(({ name }) => name),
			]),
		];
		let syncWarning: string | undefined;
		try {
			const sync = await kernel.execute(
				syncProjectBindingsSource(committedNames),
			);
			if (sync.status !== "ok")
				syncWarning = `Project notebook tracking could not be synchronized: ${sync.errorText ?? "unknown error"}`;
		} catch (error) {
			syncWarning = `Project notebook tracking could not be synchronized: ${error instanceof Error ? error.message : String(error)}`;
		}
		if (!committed.manifest)
			return {
				...emptyProjectStateSummary(),
				skipped: candidate.skipped,
				conflicts: committed.conflicts,
			};
		return {
			baseline: committed.baseline,
			restored: committed.manifest.entries,
			skipped: candidate.skipped,
			conflicts: committed.conflicts,
			...(syncWarning ? { message: syncWarning } : {}),
		};
	} finally {
		rmSync(candidatePayloadPath, { force: true });
		rmSync(candidateManifestPath, { force: true });
	}
}

export async function promoteProjectStateBindings(
	kernel: DenoJupyterKernel,
	names: string[],
): Promise<void> {
	if (names.some((name) => !IDENTIFIER.test(name)))
		throw new Error("Project notebook binding name is invalid");
	const result = await kernel.execute(promoteProjectBindingsSource(names));
	if (result.status !== "ok")
		throw new Error(
			`Project notebook bindings could not be promoted: ${result.errorText ?? "unknown error"}`,
		);
}

export async function projectStateBindingSelection(
	kernel: DenoJupyterKernel,
	signal?: AbortSignal,
): Promise<string[]> {
	const marker = `__PI_NOTEBOOK_PROJECT_BINDINGS_${randomUUID()}__`;
	return parseProjectBindingNames(
		await kernel.execute(projectBindingNamesSource(marker), { signal }),
		marker,
	);
}

export async function syncProjectStateBindings(
	kernel: DenoJupyterKernel,
	names: string[],
	signal?: AbortSignal,
): Promise<void> {
	const result = await kernel.execute(syncProjectBindingsSource(names), {
		signal,
	});
	if (result.status !== "ok")
		throw new Error(
			`Project notebook tracking could not be synchronized: ${result.errorText ?? "unknown error"}`,
		);
}
