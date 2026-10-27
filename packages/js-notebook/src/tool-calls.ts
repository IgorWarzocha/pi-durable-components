import type {
	NotebookToolDefinition,
	ToolExecutionContext,
} from "./runtime-contract.ts";

/** Per-cell ownership for ordinary Durable registrations, not a Pi delegate adapter. */
export class NativeToolCalls {
	private readonly cells = new Map<
		string,
		{
			context: ToolExecutionContext;
			tools: Map<string, NotebookToolDefinition>;
			signal: AbortSignal;
			pending: Map<number, AbortController>;
		}
	>();
	bindCell(
		id: string,
		context: ToolExecutionContext,
		tools: Map<string, NotebookToolDefinition>,
		signal: AbortSignal,
	): void {
		this.cells.set(id, { context, tools, signal, pending: new Map() });
	}
	updateCellContext(id: string, context: ToolExecutionContext): void {
		const cell = this.cells.get(id);
		if (cell) cell.context = context;
	}
	async invokeDirect(
		cellId: string,
		id: number,
		name: string,
		input: unknown,
	): Promise<unknown> {
		const cell = this.cells.get(cellId);
		const tool = cell?.tools.get(name);
		if (!cell || !tool) throw new Error(`Tool ${name} is not selected`);
		cell.signal.throwIfAborted();
		const controller = new AbortController();
		cell.pending.set(id, controller);
		const key = `${cellId}:${id}`;
		cell.context.setBlocked?.(key, true);
		try {
			return await tool.invoke(
				input,
				cell.context,
				AbortSignal.any([cell.signal, controller.signal]),
			);
		} finally {
			cell.pending.delete(id);
			cell.context.setBlocked?.(key, false);
		}
	}
	cancelCell(id: string): void {
		for (const controller of this.cells.get(id)?.pending.values() ?? [])
			controller.abort();
	}
	closeCell(id: string): void {
		this.cancelCell(id);
		this.cells.delete(id);
	}
	clear(): void {
		for (const id of this.cells.keys()) this.closeCell(id);
	}
}
