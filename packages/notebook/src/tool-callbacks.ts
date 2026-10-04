import { NotebookBridgeServer } from "./bridge-server.ts";
import type { NotebookCell } from "./cell.ts";
import type {
	NotebookMemoryUsage,
	NotebookToolDefinition,
	RuntimeResponse,
	ToolExecutionContext,
} from "./runtime-contract.ts";

/** The kernel owns hook dispatch. This host boundary owns cancellation of its HTTP callbacks. */
export class NotebookToolCallbacks {
	readonly bridge: NotebookBridgeServer;
	private readonly cells = new Map<
		string,
		{
			context: ToolExecutionContext;
			tools: Map<string, NotebookToolDefinition>;
			controllers: Set<AbortController>;
			notifications: string[];
		}
	>();

	constructor(options: {
		activeCell(): NotebookCell | undefined;
		recordMemory(usage: NotebookMemoryUsage): void;
	}) {
		const requireActiveCell = (cellId: string): NotebookCell => {
			const cell = options.activeCell();
			if (!cell || cell.id !== cellId)
				throw new Error(`Notebook cell "${cellId}" is not active`);
			return cell;
		};
		this.bridge = new NotebookBridgeServer({
			callTool: async (cellId, requestId, toolName, input) => {
				requireActiveCell(cellId);
				return this.invokeDirect(cellId, requestId, toolName.name, input);
			},
			cancelTools: (cellId) => {
				requireActiveCell(cellId);
				this.cancelCell(cellId);
			},
			emit: (cellId, items) => requireActiveCell(cellId).emit(items),
			notify: (cellId, text) => {
				requireActiveCell(cellId);
				this.notifyDirect(cellId, text);
			},
			yield: async (cellId) => {
				const cell = requireActiveCell(cellId);
				await cell.context.onYield?.();
				cell.requestYield();
			},
			memory: (cellId, usage) => {
				if (options.activeCell()?.id === cellId) options.recordMemory(usage);
			},
		});
	}

	bindCell(
		id: string,
		context: ToolExecutionContext,
		tools: Map<string, NotebookToolDefinition>,
	): void {
		this.cells.set(id, {
			context,
			tools,
			controllers: new Set(),
			notifications: [],
		});
	}
	updateCellContext(id: string, context: ToolExecutionContext): void {
		const cell = this.cells.get(id);
		if (cell) cell.context = context;
	}
	async invokeDirect(
		id: string,
		_requestId: number,
		name: string,
		input: unknown,
	): Promise<unknown> {
		const cell = this.cells.get(id);
		if (!cell) throw new Error(`Notebook cell ${id} is not active`);
		const tool = cell.tools.get(name);
		if (!tool) throw new Error(`Tool ${name} is not selected`);
		const controller = new AbortController();
		cell.controllers.add(controller);
		try {
			return await tool.invoke(input, cell.context, controller.signal);
		} finally {
			cell.controllers.delete(controller);
		}
	}
	cancelCell(id: string): void {
		for (const controller of this.cells.get(id)?.controllers ?? [])
			controller.abort(new Error("Notebook tool callback cancelled"));
	}
	notifyDirect(id: string, text: string): void {
		const cell = this.cells.get(id);
		if (cell && cell.notifications.length < 100)
			cell.notifications.push(text.slice(0, 16_384));
	}
	attach(response: RuntimeResponse): RuntimeResponse {
		const notifications =
			this.cells.get(response.cellId)?.notifications.splice(0) ?? [];
		return {
			...response,
			contentItems: [
				...response.contentItems,
				...notifications.map((text) => ({ type: "input_text" as const, text })),
			],
		};
	}
	closeCell(id: string): void {
		this.cancelCell(id);
		this.cells.delete(id);
	}
	clear(): void {
		for (const id of this.cells.keys()) this.closeCell(id);
	}
}
