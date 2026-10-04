// Adapted from pi-codex-conversion at b2006db9def12c373ae48e70044d30f7d6b7e34f, MIT. See ../NOTICE.

import {
	DEFAULT_CODE_MODE_EXEC_YIELD_MS,
	parseExecSource,
} from "../../execution/src/exec-source.ts";
import type { NotebookBridgeServer } from "./bridge-server.ts";
import { NotebookCell } from "./cell.ts";
import { NotebookCellSettlement } from "./execution-settlement.ts";
import { beginNotebookJournalCell } from "./journal.ts";
import type {
	NotebookToolDefinition,
	RuntimeResponse,
	ToolExecutionContext,
} from "./runtime-contract.ts";
import { NOTEBOOK_INTERRUPTED_NOTICE } from "./runtime-health.ts";
import type { NotebookSessionRuntime } from "./session-runtime.ts";
import { NotebookToolCallbacks } from "./tool-callbacks.ts";

const CANCEL_GRACE_MS = 250;
const TERMINATE_GRACE_MS = 1_500;

export class NotebookExecutionRuntime {
	readonly bridge: NotebookBridgeServer;
	private readonly session: () => NotebookSessionRuntime;
	private readonly prepareSession: (
		context: ToolExecutionContext,
		signal?: AbortSignal,
	) => Promise<void>;
	private readonly delegate: NotebookToolCallbacks;
	private readonly settlement: NotebookCellSettlement;
	private readonly stopOperations = new WeakMap<NotebookCell, Promise<void>>();
	private activeCell: NotebookCell | undefined;
	private nextCellId = 1;
	private starting = false;

	constructor(
		session: () => NotebookSessionRuntime,
		prepareSession: (
			context: ToolExecutionContext,
			signal?: AbortSignal,
		) => Promise<void>,
	) {
		this.session = session;
		this.prepareSession = prepareSession;
		this.delegate = new NotebookToolCallbacks({
			activeCell: () => this.activeCell,
			recordMemory: (usage) => this.session().observations.recordMemory(usage),
		});
		this.bridge = this.delegate.bridge;
		this.settlement = new NotebookCellSettlement(
			this.session,
			this.delegate,
			this.bridge.exitToken,
			() => {
				if (this.activeCell) this.delegate.cancelCell(this.activeCell.id);
			},
		);
	}

	activeCellId(): string | undefined {
		return this.activeCell?.id;
	}
	runningCellId(): string | undefined {
		return this.activeCell && !this.activeCell.result
			? this.activeCell.id
			: undefined;
	}

	async execute(
		source: string,
		context: ToolExecutionContext,
		signal?: AbortSignal,
		tools: NotebookToolDefinition[] = [],
	): Promise<RuntimeResponse> {
		if (this.starting || this.activeCell)
			throw new Error(
				"A notebook exec cell is already active; wait or terminate it first",
			);
		this.starting = true;
		try {
			return await this.executeReserved(source, context, signal, tools);
		} finally {
			this.starting = false;
		}
	}

	private async executeReserved(
		source: string,
		context: ToolExecutionContext,
		signal?: AbortSignal,
		tools: NotebookToolDefinition[] = [],
	): Promise<RuntimeResponse> {
		signal?.throwIfAborted();
		if (this.activeCell) {
			throw new Error(
				`Notebook exec cell "${this.activeCell.id}" is still active; call wait or terminate it before starting another cell`,
			);
		}
		const session = this.session();
		await this.prepareSession(context, signal);
		await session.checkpoints.flush();
		const { code, yieldTimeMs, maxOutputTokens } = parseExecSource(source);
		const effectiveYieldTime = yieldTimeMs ?? DEFAULT_CODE_MODE_EXEC_YIELD_MS;
		this.nextCellId = Math.max(
			this.nextCellId,
			(session.observations.journal()?.cells ?? 0) + 1,
		);
		const id = `notebook-${this.nextCellId++}`;
		session.observations.recordMemory(undefined);
		const cell = new NotebookCell({
			id,
			source: code,
			context,
			maxOutputTokens: maxOutputTokens ?? 10_000,
		});
		cell.context = this.withCellContext(cell, context);
		const notice = session.observations.takeNotice();
		this.activeCell = cell;
		if (notice) cell.emit([{ type: "input_text", text: notice }]);
		this.delegate.bindCell(
			id,
			cell.context,
			new Map(tools.map((tool) => [tool.name, tool])),
		);
		let journaled = false;
		const journal = session.observations.journal();
		if (journal) {
			try {
				beginNotebookJournalCell(journal, { id, source: cell.source });
				journaled = true;
			} catch (error) {
				this.settlement.reportJournalFailure(error, "start", cell);
			}
		}
		const metadata = tools.map((tool) => ({
			name: tool.name,
			description: tool.help ?? tool.usage + "\n" + tool.description,
		}));
		const toolNames = Object.fromEntries(
			tools.map((tool) => [tool.name, { name: tool.name }]),
		);
		const outputHints = Object.fromEntries(
			tools.flatMap((tool) =>
				"textOutput" in tool && tool.textOutput !== undefined
					? [[tool.name, tool.textOutput]]
					: [],
			),
		);
		const wrapped = [
			`if (typeof globalThis.__piNotebook?.begin !== "function") throw new Error("Notebook runtime bootstrap unavailable: __piNotebook.begin");`,
			`await globalThis.__piNotebook.begin(${JSON.stringify(id)}, ${JSON.stringify(metadata)}, JSON.parse(${JSON.stringify(JSON.stringify(toolNames))}), JSON.parse(${JSON.stringify(JSON.stringify(outputHints))}));`,
			code,
			`if (typeof globalThis.__piNotebook?.flush !== "function") throw new Error("Notebook runtime bootstrap unavailable: __piNotebook.flush");`,
			`await globalThis.__piNotebook.flush(${JSON.stringify(id)});`,
			"undefined;",
		].join("\n");
		const abort = () => {
			cell.controller.abort();
			void this.stopAndCloseCell(cell).catch(() => undefined);
		};
		signal?.addEventListener("abort", abort, { once: true });
		void this.settlement
			.run(cell, wrapped, journaled)
			.finally(() => signal?.removeEventListener("abort", abort));
		try {
			return await this.observe(cell, effectiveYieldTime, signal);
		} catch (error) {
			if (signal?.aborted)
				await this.stopAndCloseCell(cell).catch(() => undefined);
			throw error;
		}
	}

	async wait(
		cellId: string,
		yieldTimeMs: number,
		context: ToolExecutionContext,
		signal?: AbortSignal,
	): Promise<RuntimeResponse> {
		const cell = this.activeCell;
		if (!cell || cell.id !== cellId)
			return this.withMemory({
				kind: "result",
				cellId,
				contentItems: [],
				missingCell: true,
			});
		cell.context = this.withCellContext(cell, context);
		this.delegate.updateCellContext(cellId, cell.context);
		try {
			return await this.observe(cell, yieldTimeMs, signal);
		} catch (error) {
			if (signal?.aborted) await this.stopAndCloseCell(cell);
			throw error;
		}
	}

	async terminate(
		cellId: string,
		context: ToolExecutionContext,
		signal?: AbortSignal,
	): Promise<RuntimeResponse> {
		signal?.throwIfAborted();
		const cell = this.activeCell;
		if (!cell || cell.id !== cellId)
			return this.withMemory({
				kind: "terminated",
				cellId,
				contentItems: [],
				missingCell: true,
			});
		cell.context = this.withCellContext(cell, context);
		this.delegate.updateCellContext(cellId, cell.context);
		await this.stopCell(cell);
		return this.finishObservation(cell, "terminated");
	}

	async stopActive(): Promise<string | undefined> {
		const cell = this.activeCell;
		if (!cell) return undefined;
		await this.stopCell(cell);
		this.closeCell(cell);
		return cell.id;
	}

	clear(): void {
		this.activeCell = undefined;
		this.delegate.clear();
		this.session().observations.recordMemory(undefined);
	}

	private async observe(
		cell: NotebookCell,
		yieldTimeMs: number,
		signal?: AbortSignal,
	): Promise<RuntimeResponse> {
		signal?.throwIfAborted();
		return this.finishObservation(
			cell,
			await cell.observe(yieldTimeMs, signal),
		);
	}

	private finishObservation(
		cell: NotebookCell,
		kind: RuntimeResponse["kind"],
	): RuntimeResponse {
		const notice = this.session().observations.takeNotice();
		if (notice) cell.emit([{ type: "input_text", text: notice }]);
		const contentItems = cell.takeContent();
		const response: RuntimeResponse =
			kind === "result"
				? {
						kind,
						cellId: cell.id,
						contentItems,
						...(cell.result?.status === "error" && cell.result.errorText
							? { errorText: cell.result.errorText }
							: {}),
						maxOutputTokens: cell.maxOutputTokens,
					}
				: kind === "terminated"
					? { kind, cellId: cell.id, contentItems }
					: {
							kind,
							cellId: cell.id,
							contentItems,
							maxOutputTokens: cell.maxOutputTokens,
						};
		const attached = this.delegate.attach(this.withMemory(response));
		if (kind !== "yielded") this.closeCell(cell);
		return attached;
	}

	private stopCell(cell: NotebookCell): Promise<void> {
		const existing = this.stopOperations.get(cell);
		if (existing) return existing;
		const operation = this.stopCellInner(cell).finally(() =>
			this.stopOperations.delete(cell),
		);
		this.stopOperations.set(cell, operation);
		return operation;
	}

	private async stopCellInner(cell: NotebookCell): Promise<void> {
		const isolateKernel = !cell.isCompleted();
		cell.terminated = true;
		cell.controller.abort();
		this.delegate.cancelCell(cell.id);
		await Promise.race([cell.waitForCompletion(), delay(CANCEL_GRACE_MS)]);
		if (!cell.isCompleted()) {
			const kernel = this.session().kernel();
			try {
				await kernel?.interrupt();
			} catch {}
		}
		if (isolateKernel)
			await this.session().invalidateKernel(NOTEBOOK_INTERRUPTED_NOTICE);
		await Promise.race([cell.waitForCompletion(), delay(TERMINATE_GRACE_MS)]);
		if (!cell.isCompleted()) {
			cell.result = { status: "aborted", items: [] };
			cell.markCompleted();
		}
	}

	private async stopAndCloseCell(cell: NotebookCell): Promise<void> {
		await this.stopCell(cell);
		this.closeCell(cell);
	}

	private closeCell(cell: NotebookCell): void {
		if (this.activeCell === cell) this.activeCell = undefined;
		this.delegate.closeCell(cell.id);
	}

	private withCellContext(
		cell: NotebookCell,
		context: ToolExecutionContext,
	): ToolExecutionContext {
		return {
			...context,
			setBlocked: (blockerId, active) => cell.setBlocked(blockerId, active),
		};
	}

	private withMemory(response: RuntimeResponse): RuntimeResponse {
		const memory = this.session().observations.memory();
		return memory ? { ...response, notebookMemory: memory } : response;
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
