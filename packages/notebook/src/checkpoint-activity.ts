// Adapted from pi-codex-conversion at 81d48c1e2937244991b9f054450215a95b8ea8c6, MIT. See ../NOTICE.
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	rmdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { NotebookCheckpointIdentity } from "./checkpoint-format.ts";
import { checkpointPaths } from "./checkpoint-store.ts";
import { acquireDirectoryLock } from "./directory-lock.ts";

export interface NotebookCheckpointActivity {
	touch(): void;
	release(): void;
}

function notebookStorageDirectory(agentDir: string): string {
	return join(agentDir, "cache", "pi-durable-notebook");
}

function errorCode(error: unknown): string | undefined {
	return error instanceof Error &&
		"code" in error &&
		typeof error.code === "string"
		? error.code
		: undefined;
}

function directoryEntries(path: string) {
	try {
		return readdirSync(path, { withFileTypes: true });
	} catch (error) {
		if (errorCode(error) === "ENOENT") return [];
		throw error;
	}
}

function removeEmptyActivityDirectory(path: string): void {
	try {
		rmdirSync(path);
	} catch (error) {
		if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(errorCode(error) ?? ""))
			throw error;
	}
}

async function retentionLock(agentDir: string, signal?: AbortSignal) {
	const root = notebookStorageDirectory(agentDir);
	mkdirSync(root, { recursive: true });
	return acquireDirectoryLock(join(root, "checkpoint-retention.lock"), {
		waitMs: 10_000,
		staleMs: 30_000,
		pollMs: 20,
		signal,
	});
}

// Held for the native session, including idle/invalidated kernels. Multiple processes may resume the same identity.
export async function activateNotebookCheckpoint(
	identity: NotebookCheckpointIdentity,
	signal?: AbortSignal,
): Promise<NotebookCheckpointActivity> {
	const directory = checkpointPaths(identity).directory;
	const lock = await retentionLock(identity.agentDir, signal);
	try {
		const activityDirectory = join(
			notebookStorageDirectory(identity.agentDir),
			"active-sessions",
			basename(directory),
		);
		mkdirSync(activityDirectory, { recursive: true });
		const owner = join(
			activityDirectory,
			`active-${process.pid}-${randomUUID()}`,
		);
		const used = join(directory, "last-used");
		writeFileSync(owner, "", { mode: 0o600 });
		const touch = () => {
			try {
				if (existsSync(directory)) writeFileSync(used, "", { mode: 0o600 });
			} catch (error) {
				if (errorCode(error) !== "ENOENT") throw error;
			}
		};
		try {
			touch();
		} catch (error) {
			rmSync(owner, { force: true });
			removeEmptyActivityDirectory(activityDirectory);
			throw error;
		}
		let released = false;
		return {
			touch: () => {
				if (!released) touch();
			},
			release: () => {
				if (released) return;
				// Last use precedes removal of our protection, including long-idle live sessions.
				touch();
				rmSync(owner, { force: true });
				removeEmptyActivityDirectory(activityDirectory);
				released = true;
			},
		};
	} finally {
		lock?.release();
	}
}

export async function expireNotebookSessionCheckpoints(
	agentDir: string,
	retentionAge: () => number | undefined,
	now = Date.now(),
): Promise<void> {
	const root = join(notebookStorageDirectory(agentDir), "sessions");
	const activityRoot = join(
		notebookStorageDirectory(agentDir),
		"active-sessions",
	);
	if (!existsSync(root) && !existsSync(activityRoot)) return;
	const lock = await retentionLock(agentDir);
	try {
		const active = new Set<string>();
		for (const entry of directoryEntries(activityRoot)) {
			if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
			const directory = join(activityRoot, entry.name);
			for (const file of directoryEntries(directory)) {
				const owner = file.name.match(/^active-([1-9][0-9]*)-[a-f0-9-]{36}$/);
				if (!owner) continue;
				try {
					process.kill(Number(owner[1]), 0);
					active.add(entry.name);
				} catch (error) {
					if (errorCode(error) === "ESRCH")
						rmSync(join(directory, file.name), { force: true });
					else active.add(entry.name);
				}
			}
			removeEmptyActivityDirectory(directory);
		}
		if (retentionAge() === undefined || !existsSync(root)) return;
		for (const entry of directoryEntries(root)) {
			if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
			if (active.has(entry.name)) continue;
			const directory = join(root, entry.name);
			// Legacy checkpoints have no activity file; their latest actual checkpoint write is the baseline.
			const activity = join(directory, "last-used");
			const manifest = join(directory, "checkpoint.json");
			let modified: number;
			try {
				modified = Math.max(
					existsSync(activity) ? statSync(activity).mtimeMs : 0,
					existsSync(manifest)
						? statSync(manifest).mtimeMs
						: statSync(directory).mtimeMs,
				);
			} catch (error) {
				if (errorCode(error) === "ENOENT") continue;
				throw error;
			}
			const maxAgeMs = retentionAge();
			if (maxAgeMs === undefined) return;
			if (now - modified >= maxAgeMs) {
				rmSync(directory, { recursive: true, force: true });
			}
		}
	} finally {
		lock?.release();
	}
}
