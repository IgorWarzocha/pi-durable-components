// Adapted from pi-codex-conversion at b2006db9def12c373ae48e70044d30f7d6b7e34f, MIT. See ../NOTICE.

import { existsSync } from "node:fs";
import type { NotebookCheckpointIdentity } from "./checkpoint-format.ts";
import {
	initializeNotebookJournal,
	materializeNotebookJournal,
	type NotebookJournal,
} from "./journal.ts";
import {
	extractNotebookNpmImports,
	recordNotebookNpmImports,
} from "./npm-imports.ts";
import type { NotebookMemoryUsage } from "./runtime-contract.ts";
import type { NotebookStorageRetention } from "./storage-retention.ts";

const MAX_NOTICE_CHARS = 16_384;
/** Runtime observations are cleared independently of durable checkpoint identity. */
export class NotebookSessionObservations {
	private notice: string | undefined;
	private memoryValue: NotebookMemoryUsage | undefined;
	private journalValue: NotebookJournal | undefined;
	private startedAtValue: number | undefined;
	private completedCells = 0;
	private readonly identity: () => NotebookCheckpointIdentity | undefined;
	private readonly checkpointStatus: () => Record<string, unknown>;
	private readonly storage: NotebookStorageRetention;
	private readonly maxBytes: number;
	constructor(
		identity: () => NotebookCheckpointIdentity | undefined,
		checkpointStatus: () => Record<string, unknown>,
		storage: NotebookStorageRetention,
		maxBytes: number,
	) {
		this.identity = identity;
		this.checkpointStatus = checkpointStatus;
		this.storage = storage;
		this.maxBytes = maxBytes;
	}
	started(journal: NotebookJournal | undefined): void {
		this.startedAtValue = Date.now();
		this.journalValue = journal;
		this.completedCells = journal?.completedCells ?? 0;
	}
	resetMemory(): void {
		this.memoryValue = undefined;
		this.startedAtValue = undefined;
	}
	clearNotice(): void {
		this.notice = undefined;
	}
	clear(): void {
		this.resetMemory();
		this.clearNotice();
		this.journalValue = undefined;
		this.completedCells = 0;
	}
	journal(): NotebookJournal | undefined {
		if (this.storage.policy().journals === "off") return undefined;
		const identity = this.identity();
		if (
			identity &&
			(!this.journalValue || !existsSync(this.journalValue.path))
		) {
			this.journalValue = initializeNotebookJournal(
				identity,
				this.maxBytes,
				this.storage,
			);
		}
		return this.journalValue;
	}
	recordCompletedCell(): void {
		this.completedCells++;
	}
	materializeJournal(): void {
		const journal = this.journal();
		if (journal) materializeNotebookJournal(journal);
	}
	recordMemory(memory: NotebookMemoryUsage | undefined): void {
		this.memoryValue = memory;
	}
	async recordNpmImports(source: string): Promise<void> {
		const identity = this.identity();
		if (!identity) return;
		const imports = extractNotebookNpmImports(source);
		if (imports.length === 0) return;
		try {
			await recordNotebookNpmImports(identity, imports);
		} catch (error) {
			this.addNotice(
				`Notebook npm inventory was not updated: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	memory(): NotebookMemoryUsage | undefined {
		return this.memoryValue;
	}
	addNotice(notice: string): void {
		this.notice = joinNotices(this.notice, notice);
	}
	takeNotice(): string | undefined {
		const notice = this.notice;
		this.notice = undefined;
		return notice;
	}

	metadata(): {
		startedAt?: number | undefined;
		userCells: number;
		memory?: NotebookMemoryUsage | undefined;
		checkpoint: Record<string, unknown>;
	} {
		return {
			startedAt: this.startedAtValue,
			userCells: Math.max(
				this.completedCells,
				this.journalValue?.completedCells ?? 0,
			),
			memory: this.memoryValue,
			checkpoint: this.checkpointStatus(),
		};
	}
}

function joinNotices(
	...notices: Array<string | undefined>
): string | undefined {
	const present = notices.filter((notice): notice is string => Boolean(notice));
	if (present.length === 0) return undefined;
	const marker = " [Notebook notices truncated]";
	let output = "";
	for (let index = 0; index < present.length; index += 1) {
		const notice = present[index]!;
		const separator = output ? ". " : "";
		const remaining = MAX_NOTICE_CHARS - output.length - separator.length;
		if (
			remaining <= 0 ||
			notice.length > remaining ||
			(index < present.length - 1 && notice.length === remaining)
		) {
			return `${output}${separator}${notice.slice(0, Math.max(0, remaining - marker.length))}${marker}`.slice(
				0,
				MAX_NOTICE_CHARS,
			);
		}
		output += `${separator}${notice}`;
	}
	return output;
}
