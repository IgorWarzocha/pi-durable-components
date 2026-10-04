// Adapted from pi-codex-conversion at b2006db9def12c373ae48e70044d30f7d6b7e34f, MIT. See ../NOTICE.

import type { NotebookCheckpointIdentity } from "./checkpoint-format.ts";
import { materializeNotebookJournal, type NotebookJournal } from "./journal.ts";
import {
	extractNotebookNpmImports,
	recordNotebookNpmImports,
} from "./npm-imports.ts";
import type { NotebookMemoryUsage } from "./runtime-contract.ts";

const MAX_NOTICE_CHARS = 16_384;
/** Runtime observations are cleared independently of durable checkpoint identity. */
export class NotebookSessionObservations {
	private notice: string | undefined;
	private memoryValue: NotebookMemoryUsage | undefined;
	private journalValue: NotebookJournal | undefined;
	private startedAtValue: number | undefined;
	private readonly identity: () => NotebookCheckpointIdentity | undefined;
	private readonly checkpointStatus: () => Record<string, unknown>;
	constructor(
		identity: () => NotebookCheckpointIdentity | undefined,
		checkpointStatus: () => Record<string, unknown>,
	) {
		this.identity = identity;
		this.checkpointStatus = checkpointStatus;
	}
	started(journal: NotebookJournal): void {
		this.startedAtValue = Date.now();
		this.journalValue = journal;
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
	}
	journal(): NotebookJournal | undefined {
		return this.journalValue;
	}
	materializeJournal(): void {
		if (this.journalValue) materializeNotebookJournal(this.journalValue);
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
			userCells: this.journalValue?.completedCells ?? 0,
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
