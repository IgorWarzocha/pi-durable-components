// Adapted from pi-codex-conversion at 81d48c1e2937244991b9f054450215a95b8ea8c6, MIT. See ../NOTICE.
import {
	existsSync,
	mkdirSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { expireNotebookSessionCheckpoints } from "./checkpoint-activity.ts";
import { acquireDirectoryLock } from "./directory-lock.ts";

export type NotebookJournalRetention = "off" | "week" | "on";
export type NotebookCheckpointRetention = "never" | "month" | "week";
export interface NotebookStoragePolicy {
	journals?: NotebookJournalRetention;
	checkpointCleanup?: NotebookCheckpointRetention;
}
const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

/** Owns coalesced maintenance. The host supplies policy, never Pi-global paths. */
export class NotebookStorageRetention {
	private pending: Promise<void> | undefined;
	private forceAgain = false;
	readonly agentDir: string;
	private readonly getPolicy: (() => NotebookStoragePolicy) | undefined;
	constructor(agentDir: string, getPolicy?: () => NotebookStoragePolicy) {
		this.agentDir = agentDir;
		this.getPolicy = getPolicy;
	}
	policy(): Required<NotebookStoragePolicy> {
		const value = this.getPolicy?.() ?? {};
		const journals = value.journals ?? "week";
		const checkpointCleanup = value.checkpointCleanup ?? "never";
		if (
			!["off", "week", "on"].includes(journals) ||
			!["never", "month", "week"].includes(checkpointCleanup)
		) {
			throw new Error("Invalid Notebook storage policy");
		}
		return { journals, checkpointCleanup };
	}

	schedule(): void {
		if (this.pending) return;
		void this.maintain(false).catch((error) =>
			console.warn(
				`Notebook storage cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
			),
		);
	}

	maintain(force = true): Promise<void> {
		if (this.pending) {
			if (force) this.forceAgain = true;
			return this.pending;
		}
		this.pending = (async () => {
			do {
				this.forceAgain = false;
				await this.pass(force);
				force = this.forceAgain;
			} while (force);
		})().finally(() => {
			this.pending = undefined;
		});
		return this.pending;
	}

	async drain(): Promise<void> {
		await this.pending;
	}

	private async pass(force: boolean): Promise<void> {
		const root = notebookJournalsDirectory(this.agentDir);
		const stamp = join(dirname(root), "storage-maintenance");
		mkdirSync(dirname(root), { recursive: true });
		const lock = await acquireDirectoryLock(
			join(dirname(root), "storage-retention.lock"),
			{ waitMs: 10_000, staleMs: 30_000, pollMs: 20 },
		);
		try {
			const now = Date.now();
			if (!force && existsSync(stamp) && now - statSync(stamp).mtimeMs < DAY_MS)
				return;
			maintainNotebookJournals(this, now);
			await expireNotebookSessionCheckpoints(
				this.agentDir,
				() => {
					const retention = this.policy().checkpointCleanup;
					return retention === "never"
						? undefined
						: retention === "month"
							? 30 * DAY_MS
							: WEEK_MS;
				},
				now,
			);
			mkdirSync(dirname(stamp), { recursive: true });
			writeFileSync(stamp, "", { mode: 0o600 });
		} finally {
			lock?.release();
		}
	}
}

export function notebookJournalsDirectory(agentDir: string): string {
	return join(agentDir, "cache", "pi-durable-notebook", "journals");
}

function maintainNotebookJournals(
	storage: NotebookStorageRetention,
	now: number,
): void {
	const retention = storage.policy().journals;
	const root = notebookJournalsDirectory(storage.agentDir);
	if (retention === "off") {
		rmSync(root, { recursive: true, force: true });
	} else if (retention === "week" && existsSync(root)) {
		for (const project of readdirSync(root, { withFileTypes: true })) {
			if (!project.isDirectory() || !/^[a-f0-9]{64}$/.test(project.name))
				continue;
			const directory = join(root, project.name);
			const groups = new Map<string, string[]>();
			for (const file of readdirSync(directory, { withFileTypes: true })) {
				const match = file.name.match(
					/^([a-f0-9]{64})(?:\.previous)?\.ipynb(?:\.events\.jsonl|(?:\.replacement)?(?:\.[a-f0-9-]{36}\.tmp)?)$/,
				);
				if (!file.isFile() || !match) continue;
				const files = groups.get(match[1]!) ?? [];
				files.push(join(directory, file.name));
				groups.set(match[1]!, files);
			}
			for (const files of groups.values())
				removeExpiredNotebookJournalFiles(files, now);
		}
	}
}

export function removeExpiredNotebookJournalFiles(
	files: string[],
	now = Date.now(),
): void {
	const updatedAt = Math.max(
		...files.map((file) => {
			try {
				return statSync(file).mtimeMs;
			} catch (error) {
				if (
					error instanceof Error &&
					"code" in error &&
					error.code === "ENOENT"
				)
					return 0;
				throw error;
			}
		}),
	);
	if (now - updatedAt >= WEEK_MS)
		for (const file of files) rmSync(file, { force: true });
}
