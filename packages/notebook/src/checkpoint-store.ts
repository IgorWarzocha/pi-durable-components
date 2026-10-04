// Adapted from pi-codex-conversion at b2006db9def12c373ae48e70044d30f7d6b7e34f, MIT. See ../NOTICE.
import { createHash } from "node:crypto";
import { type Dirent, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	isValidCheckpointPayload,
	type NotebookCheckpointIdentity,
	readCheckpointManifest,
} from "./checkpoint-format.ts";

const CHECKPOINT_DIRECTORY_NAME = /^[0-9a-f]{64}$/;
export function garbageCollectSupersededNotebookCheckpoints(
	identity: NotebookCheckpointIdentity,
): void {
	const current = checkpointPaths(identity).directory;
	const sessions = resolve(current, "..");
	const family = sessionFamily(identity.session);
	let entries: Dirent[];
	try {
		entries = readdirSync(sessions, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || !CHECKPOINT_DIRECTORY_NAME.test(entry.name))
			continue;
		const directory = join(sessions, entry.name);
		if (directory === current) continue;
		const manifest = readCheckpointManifest(join(directory, "checkpoint.json"));
		if (
			!manifest ||
			manifest.project !== identity.project ||
			sessionFamily(manifest.session) !== family
		)
			continue;
		rmSync(directory, { recursive: true, force: true });
	}
}

export function removeNotebookCheckpoint(
	identity: NotebookCheckpointIdentity,
): void {
	rmSync(checkpointPaths(identity).directory, { recursive: true, force: true });
}

export function notebookCheckpointBindingNames(
	identity: NotebookCheckpointIdentity,
	maxBytes: number,
): string[] {
	const manifest = readCheckpointManifest(checkpointPaths(identity).manifest);
	return manifest?.project === identity.project &&
		manifest.session === identity.session &&
		isValidCheckpointPayload(
			manifest,
			join(checkpointPaths(identity).directory, manifest.payload),
			maxBytes,
		)
		? manifest.entries.map(({ name }) => name)
		: [];
}

export function checkpointPaths(identity: NotebookCheckpointIdentity): {
	directory: string;
	manifest: string;
} {
	const key = createHash("sha256")
		.update(`${resolve(identity.project)}\0${identity.session}`)
		.digest("hex");
	const directory = join(
		identity.agentDir,
		"cache",
		"pi-durable-notebook",
		"sessions",
		key,
	);
	return { directory, manifest: join(directory, "checkpoint.json") };
}

function sessionFamily(session: string): string {
	const separator = session.indexOf("\0");
	return separator === -1 ? session : session.slice(0, separator);
}
