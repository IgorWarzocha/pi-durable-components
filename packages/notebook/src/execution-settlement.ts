// Adapted from pi-codex-conversion at b2006db9def12c373ae48e70044d30f7d6b7e34f, MIT. See ../NOTICE.

import type { NotebookCell } from "./cell.ts";
import { finishNotebookJournalCell } from "./journal.ts";
import type { ToolExecutionContext } from "./runtime-contract.ts";
import { withNotebookRecoveryGuidance } from "./runtime-health.ts";
import type { NotebookSessionRuntime } from "./session-runtime.ts";
import type { NotebookToolCallbacks } from "./tool-callbacks.ts";
export class NotebookCellSettlement {
	private readonly session: () => NotebookSessionRuntime;
	private readonly delegate: NotebookToolCallbacks;
	private readonly exitToken: string;
	private readonly cancelActive: () => void;
	constructor(
		session: () => NotebookSessionRuntime,
		delegate: NotebookToolCallbacks,
		exitToken: string,
		cancelActive: () => void,
	) {
		this.session = session;
		this.delegate = delegate;
		this.exitToken = exitToken;
		this.cancelActive = cancelActive;
	}
	async run(
		cell: NotebookCell,
		source: string,
		journaled: boolean,
	): Promise<void> {
		const session = this.session();
		try {
			const result = await session.kernel()!.execute(source, {
				cellSource: cell.source,
				signal: cell.controller.signal,
				interruptOnAbort: false,
				onOutput: (item) => cell.emit([item]),
			});
			const normalized =
				result.errorName === "PiNotebookExit" &&
				result.errorValue === this.exitToken
					? {
							...result,
							status: "ok" as const,
							errorText: undefined,
							errorName: undefined,
							errorValue: undefined,
						}
					: result;
			cell.result = normalized;
			if (!(await session.recoverFromBootstrapFailure(normalized))) {
				await this.endCellRuntime(cell);
				if (cell.result.status === "ok") {
					await session.observations.recordNpmImports(cell.source);
					session.checkpoints.schedule();
				}
			}
		} catch (error) {
			this.delegate.cancelCell(cell.id);
			const recovery = cell.controller.signal.aborted
				? undefined
				: await this.recoverAfterFatal(cell.context);
			cell.result = {
				status: cell.controller.signal.aborted ? "aborted" : "error",
				items: [],
				errorText: `${error instanceof Error ? error.message : String(error)}${recovery ? `\n${recovery}` : ""}`,
			};
		} finally {
			const journal = session.observations.journal();
			if (cell.result && journal) {
				try {
					finishNotebookJournalCell(journal, {
						id: cell.id,
						source: cell.source,
						items: cell.items,
						result: cell.result,
					});
				} catch (error) {
					this.reportJournalFailure(
						error,
						journaled ? "completion" : "update",
						cell,
					);
				}
			}
			cell.markCompleted();
		}
	}

	private async endCellRuntime(cell: NotebookCell): Promise<void> {
		const kernel = this.session().kernel();
		if (!kernel) return;
		const id = JSON.stringify(cell.id);
		const result = await kernel.execute(
			`if (typeof globalThis.__piNotebook?.finish !== "function") throw new Error("Notebook runtime bootstrap unavailable: __piNotebook.finish"); await globalThis.__piNotebook.finish(${id}); undefined;`,
		);
		await this.session().recoverFromBootstrapFailure(result);
		if (result.status !== "ok" && cell.result?.status === "ok") {
			cell.result = {
				status: "error",
				items: [],
				errorText: result.errorText ?? "Notebook helper flush failed",
			};
		}
	}

	private async recoverAfterFatal(
		context: ToolExecutionContext,
	): Promise<string> {
		const extension = context.sessionContext;
		if (!extension)
			return "Notebook kernel could not restart because its session context is unavailable";
		this.cancelActive();
		try {
			const restoreNotice = await this.session().restart(extension);
			return `Notebook kernel restarted from the last completed checkpoint; external side effects were not rolled back${restoreNotice ? `. ${restoreNotice}` : ""}`;
		} catch (error) {
			return withNotebookRecoveryGuidance(
				`Notebook kernel restart failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	reportJournalFailure(
		error: unknown,
		operation: string,
		cell: NotebookCell,
	): void {
		cell.emit([
			{
				type: "input_text",
				text: `Notebook journal ${operation} failed: ${error instanceof Error ? error.message : String(error)}`,
			},
		]);
	}
}
