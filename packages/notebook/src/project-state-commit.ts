// Adapted from pi-codex-conversion at b2006db9def12c373ae48e70044d30f7d6b7e34f, MIT. See ../NOTICE.

import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	removeResolvedProjectConflicts,
	writeProjectConflict,
} from "./project-state-conflicts.ts";
import {
	projectStatePaths,
	readProjectStateManifest,
	readProjectStatePayload,
} from "./project-state-files.ts";
import {
	MAX_PROJECT_MANIFEST_BYTES,
	PROJECT_STATE_SCHEMA,
	type ProjectStateBaseline,
	type ProjectStateCandidate,
	type ProjectStateManifest,
} from "./project-state-format.ts";
import { withProjectStateLock } from "./project-state-lock.ts";
import {
	mergeProjectState,
	type ProjectStateMerge,
	type ProjectStatePinUpdate,
} from "./project-state-merge.ts";
export async function unpinProjectStateBindings(
	identity: { project: string; agentDir: string },
	names: string[],
	signal?: AbortSignal,
): Promise<void> {
	const paths = projectStatePaths(identity.project, identity.agentDir);
	mkdirSync(paths.directory, { recursive: true });
	await withProjectStateLock(
		paths.lock,
		async () => {
			signal?.throwIfAborted();
			const manifest = readProjectStateManifest(paths.manifest);
			if (!manifest || manifest.project !== resolve(identity.project)) {
				throw new Error(
					"Durable notebook state is missing or invalid; it was preserved",
				);
			}
			const selected = new Set(names);
			const missing = names.filter(
				(name) => !manifest.entries.some((entry) => entry.name === name),
			);
			if (missing.length > 0)
				throw new Error(
					`Durable notebook bindings not found: ${missing.join(", ")}`,
				);
			const entries = manifest.entries.map((entry) =>
				selected.has(entry.name)
					? { ...entry, pinned: undefined, hook: undefined }
					: entry,
			);
			const text = `${JSON.stringify({ ...manifest, entries, parentGeneration: manifest.generation, generation: randomUUID() }, null, 2)}\n`;
			if (Buffer.byteLength(text) > MAX_PROJECT_MANIFEST_BYTES)
				throw new Error(
					`Project manifest exceeds ${MAX_PROJECT_MANIFEST_BYTES} bytes`,
				);
			const temporary = `${paths.manifest}.${randomUUID()}.tmp`;
			try {
				writeFileSync(temporary, text, { mode: 0o600 });
				renameSync(temporary, paths.manifest);
			} finally {
				rmSync(temporary, { force: true });
			}
		},
		signal,
	);
}

export async function commitProjectStateCandidate(options: {
	paths: ReturnType<typeof projectStatePaths>;
	identity: { project: string; session: string };
	baseline: ProjectStateBaseline;
	candidate: ProjectStateCandidate;
	candidatePayload: Buffer;
	maxBytes: number;
	pins?: ProjectStatePinUpdate | undefined;
}): Promise<{
	manifest?: ProjectStateManifest | undefined;
	baseline: ProjectStateBaseline;
	conflicts: string[];
}> {
	return withProjectStateLock(options.paths.lock, async () => {
		const current = readProjectStateManifest(options.paths.manifest);
		const currentPayload = current
			? readProjectStatePayload(
					current,
					join(options.paths.directory, current.payload),
					options.maxBytes,
				)
			: Buffer.alloc(0);
		if (!currentPayload)
			throw new Error(
				"Existing project notebook payload is invalid; it was preserved without overwrite",
			);
		const merged = mergeProjectState({
			baseline: options.baseline,
			...(current ? { current } : {}),
			candidate: options.candidate,
			candidatePayload: options.candidatePayload,
			currentPayload,
			pins: options.pins,
		});
		const pinConflicts =
			options.pins?.names.filter((name) => merged.conflicts.includes(name)) ??
			[];
		if (pinConflicts.length > 0)
			throw new Error(
				`Notebook bindings changed concurrently and were not pinned: ${pinConflicts.join(", ")}`,
			);
		if (merged.payload.length > options.maxBytes)
			throw new Error("Merged project notebook exceeds the checkpoint cap");
		if (merged.conflicts.length > 0)
			writeProjectConflict(options.paths.directory, options.identity, merged);
		const manifest = merged.changed
			? writeMergedProjectState(
					options.paths,
					options.identity,
					current,
					options.candidate,
					merged,
				)
			: current;
		removeResolvedProjectConflicts(
			options.paths.directory,
			new Set(merged.appliedNames),
		);
		return {
			...(manifest ? { manifest } : {}),
			baseline: {
				...merged.baseline,
				generation: manifest?.generation ?? merged.baseline.generation,
			},
			conflicts: merged.conflicts,
		};
	});
}

function writeMergedProjectState(
	paths: ReturnType<typeof projectStatePaths>,
	identity: { project: string; session: string },
	current: ProjectStateManifest | undefined,
	candidate: ProjectStateCandidate,
	merged: ProjectStateMerge,
): ProjectStateManifest {
	const generation = randomUUID();
	const payload = `project-${generation}.bin`;
	const manifest: ProjectStateManifest = {
		schema: PROJECT_STATE_SCHEMA,
		project: resolve(identity.project),
		generation,
		...(current ? { parentGeneration: current.generation } : {}),
		deno: candidate.deno,
		v8: candidate.v8,
		payload,
		createdAt: new Date().toISOString(),
		sourceSession: identity.session,
		entries: merged.entries,
		skipped: candidate.skipped,
	};
	const text = `${JSON.stringify(manifest, null, 2)}\n`;
	if (Buffer.byteLength(text) > MAX_PROJECT_MANIFEST_BYTES)
		throw new Error(
			`Project manifest exceeds ${MAX_PROJECT_MANIFEST_BYTES} bytes`,
		);
	writeFileSync(join(paths.directory, payload), merged.payload, {
		mode: 0o600,
	});
	const temporary = `${paths.manifest}.${randomUUID()}.tmp`;
	writeFileSync(temporary, text, { mode: 0o600 });
	renameSync(temporary, paths.manifest);
	if (current?.payload && current.payload !== payload) {
		try {
			rmSync(join(paths.directory, current.payload), { force: true });
		} catch {}
	}
	return manifest;
}
