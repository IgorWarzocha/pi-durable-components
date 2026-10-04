// Adapted from pi-codex-conversion at b2006db9def12c373ae48e70044d30f7d6b7e34f, MIT. See ../NOTICE.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	CHECKPOINT_SCHEMA,
	type CheckpointManifest,
	isValidCheckpointPayload,
	type NotebookCheckpointIdentity,
	readCheckpointManifest,
} from "./checkpoint-format.ts";
import { checkpointSource, restoreSource } from "./checkpoint-runtime.ts";
import { checkpointPaths } from "./checkpoint-store.ts";
import type { DenoJupyterKernel } from "./jupyter-kernel.ts";
import {
	MAX_PROJECT_ENTRIES,
	MAX_PROJECT_NAME_BYTES,
	type ProjectStateBaseline,
} from "./project-state-format.ts";

const NOTEBOOK_CHECKPOINT_MAX_BYTES = 256 * 1024 * 1024;
const NOTEBOOK_CHECKPOINT_MIN_BYTES = 8 * 1024 * 1024;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export type { NotebookCheckpointIdentity } from "./checkpoint-format.ts";

export interface NotebookCheckpointSummary {
	restored: string[];
	skipped: Array<{ name: string; reason: string }>;
	message?: string | undefined;
}

export function resolveNotebookCheckpointMaxBytes(maxHeapMiB: number): number {
	const heapRelative = Math.floor((maxHeapMiB * 1024 * 1024) / 8);
	return Math.min(
		NOTEBOOK_CHECKPOINT_MAX_BYTES,
		Math.max(NOTEBOOK_CHECKPOINT_MIN_BYTES, heapRelative),
	);
}

export async function writeNotebookCheckpoint(
	kernel: DenoJupyterKernel,
	identity: NotebookCheckpointIdentity,
	baselineNames: ReadonlySet<string>,
	maxBytes: number,
	projectBaseline: ProjectStateBaseline,
	excludeNames: ReadonlySet<string> = new Set(),
): Promise<CheckpointManifest> {
	const paths = checkpointPaths(identity);
	mkdirSync(paths.directory, { recursive: true });
	const names = [...new Set(await kernel.complete("", 0))].sort();
	const privateNames = names.filter(
		(name) => !baselineNames.has(name) && !excludeNames.has(name),
	);
	if (privateNames.length > MAX_PROJECT_ENTRIES) {
		throw new Error(
			`Notebook checkpoint exceeds ${MAX_PROJECT_ENTRIES} top-level values`,
		);
	}
	if (
		privateNames.some(
			(name) => Buffer.byteLength(name) > MAX_PROJECT_NAME_BYTES,
		)
	) {
		throw new Error(
			`Notebook checkpoint name exceeds ${MAX_PROJECT_NAME_BYTES} bytes`,
		);
	}
	const skippedInvalid = privateNames
		.filter((name) => !IDENTIFIER.test(name))
		.map((name) => ({ name, reason: "unsupported identifier" }));
	const candidates = privateNames.filter((name) => IDENTIFIER.test(name));
	const payload = `checkpoint-${randomUUID()}.bin`;
	const previousPayload = readCheckpointManifest(paths.manifest)?.payload;
	const source = checkpointSource({
		candidates,
		payloadPath: join(paths.directory, payload),
		manifestPath: paths.manifest,
		directory: paths.directory,
		identity,
		projectGeneration: projectBaseline.generation,
		projectNames: projectBaseline.entries.map(({ name }) => name),
		payload,
		...(previousPayload ? { previousPayload } : {}),
		skippedInvalid,
		maxBytes,
	});
	const result = await kernel.execute(source);
	if (result.status !== "ok")
		throw new Error(
			`Notebook checkpoint failed: ${result.errorText ?? "unknown error"}`,
		);
	const manifest = readCheckpointManifest(paths.manifest);
	if (!manifest)
		throw new Error("Notebook checkpoint did not produce a valid manifest");
	return manifest;
}

export async function restoreNotebookCheckpoint(
	kernel: DenoJupyterKernel,
	identity: NotebookCheckpointIdentity,
	maxBytes: number,
	projectBaseline: ProjectStateBaseline,
	signal?: AbortSignal,
): Promise<NotebookCheckpointSummary> {
	signal?.throwIfAborted();
	const paths = checkpointPaths(identity);
	if (!existsSync(paths.manifest)) return { restored: [], skipped: [] };
	const manifest = readCheckpointManifest(paths.manifest);
	if (!manifest)
		return {
			restored: [],
			skipped: [],
			message: "Notebook checkpoint was invalid and was not restored",
		};
	if (
		manifest.schema !== CHECKPOINT_SCHEMA ||
		manifest.project !== identity.project ||
		manifest.session !== identity.session
	) {
		return {
			restored: [],
			skipped: manifest.skipped,
			message:
				"Notebook checkpoint identity was incompatible and was not restored",
		};
	}
	const payloadPath = join(paths.directory, manifest.payload);
	if (!isValidCheckpointPayload(manifest, payloadPath, maxBytes)) {
		return {
			restored: [],
			skipped: manifest.skipped,
			message:
				"Notebook checkpoint payload was missing or invalid and was not restored",
		};
	}
	signal?.throwIfAborted();
	const excluded = sessionCheckpointProjectExclusions(
		manifest,
		projectBaseline,
	);
	const result = await kernel.execute(
		restoreSource(manifest, payloadPath, excluded),
		{ signal },
	);
	if (result.status !== "ok") {
		return {
			restored: [],
			skipped: manifest.skipped,
			message: `Notebook checkpoint was incompatible and was not restored: ${result.errorText ?? "unknown error"}`,
		};
	}
	const restored = manifest.entries
		.map((entry) => entry.name)
		.filter((name) => !excluded.has(name));
	return {
		restored,
		skipped: manifest.skipped,
		...(excluded.size > 0
			? {
					message:
						"Session checkpoint came from an older project generation; current project bindings took precedence",
				}
			: {}),
	};
}

function sessionCheckpointProjectExclusions(
	manifest: Pick<CheckpointManifest, "projectGeneration" | "projectNames">,
	projectBaseline: ProjectStateBaseline,
): Set<string> {
	return manifest.projectGeneration &&
		manifest.projectGeneration !== projectBaseline.generation
		? new Set([
				...projectBaseline.entries.map(({ name }) => name),
				...(manifest.projectNames ?? []),
			])
		: new Set();
}
