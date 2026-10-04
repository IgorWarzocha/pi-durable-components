import { randomUUID } from "node:crypto";
import {
	type DelegateRequestMessage,
	executionCellId,
	type HostMessage,
	parseExecSource,
	parseRuntimeResponse,
	runtimeOutcome,
} from "./host-protocol.ts";
import { CodeModeHostSession } from "./host-session.ts";
import type {
	RuntimeCallbacks,
	RuntimeResponse,
	RuntimeTool,
} from "./runtime-contract.ts";

interface Cell {
	tools: ReadonlyMap<string, RuntimeTool>;
	callbacks: RuntimeCallbacks;
	yieldMarker: string;
}

/** Standalone pinned V8 host. No filesystem, network or process capability enters the isolate. */
export class CodeHostRuntime {
	private readonly session: CodeModeHostSession;
	private readonly cells = new Map<string, Cell>();
	private readonly delegates = new Map<
		number,
		{ cellId: string; controller: AbortController }
	>();
	private closed = false;
	private failure: Error | undefined;
	private readonly failureController = new AbortController();

	get failureSignal(): AbortSignal {
		return this.failureController.signal;
	}

	constructor(binary: string) {
		this.session = new CodeModeHostSession({
			binary,
			onMessage: (message) => this.handle(message),
			onFailure: (error) => {
				if (!this.closed) {
					this.failure = error;
					this.failureController.abort(error);
				}
				this.closed = true;
				this.clear();
			},
		});
	}

	async execute(
		source: string,
		tools: readonly RuntimeTool[],
		callbacks: RuntimeCallbacks,
		signal?: AbortSignal,
		onStarted?: (cellId: string) => void,
		yieldTimeMsOverride?: number,
	): Promise<RuntimeResponse> {
		if (this.closed)
			throw new Error(
				this.failure
					? `Code host stopped and session state was lost: ${this.failure.message}. Previous cell outcomes may be uncertain. Recreate the Code component before running new code`
					: "Code runtime is closed",
			);
		signal?.throwIfAborted();
		const parsed = parseExecSource(source);
		await this.session.start();
		signal?.throwIfAborted();
		const id = this.session.nextRequestId();
		const initial = this.session.expectInitial(id);
		void initial.catch(() => undefined);
		let cellId: string | undefined;
		const yieldMarker = `durable-yield-${randomUUID()}`;
		const abort = () => {
			if (cellId) void this.terminate(cellId).catch(() => undefined);
			else void this.close(); // Unknown admission is never replayed.
		};
		signal?.addEventListener("abort", abort, { once: true });
		try {
			await this.session.requestWithId(
				id,
				{
					method: "session/execute",
					sessionId: this.session.id,
					request: {
						tool_call_id: `exec-${id}`,
						enabled_tools: tools.map((tool, index) => ({
							name: `durable_tool_${index}`,
							tool_name: { name: tool.name, namespace: null },
							description: tool.description,
							kind: "function",
							input_schema: tool.inputSchema,
							output_schema: null,
						})),
						source: toolBootstrap(tools, yieldMarker) + parsed.code,
						yield_time_ms: yieldTimeMsOverride ?? parsed.yieldTimeMs ?? 30_000,
						max_output_tokens: parsed.maxOutputTokens,
					},
				},
				(value) => {
					cellId = executionCellId(value);
					if (!cellId)
						throw new Error("Code host did not return a started cell");
					this.cells.set(cellId, {
						tools: new Map(tools.map((tool) => [tool.name, tool])),
						callbacks,
						yieldMarker,
					});
					onStarted?.(cellId);
				},
			);
			signal?.throwIfAborted();
			return parseRuntimeResponse(await initial);
		} catch (error) {
			this.session.rejectOperation(
				id,
				error instanceof Error ? error : new Error(String(error)),
			);
			throw error;
		} finally {
			signal?.removeEventListener("abort", abort);
		}
	}

	async wait(
		cellId: string,
		yieldTimeMs = 30_000,
		signal?: AbortSignal,
	): Promise<RuntimeResponse> {
		signal?.throwIfAborted();
		const id = this.session.nextRequestId();
		const abort = () => {
			try {
				this.session.send({ type: "operation/cancel", id });
			} catch {
				/* Already closed. */
			}
			this.session.rejectOperation(id, new Error("Code wait aborted"));
		};
		signal?.addEventListener("abort", abort, { once: true });
		try {
			const value = await this.session.requestWithId(id, {
				method: "session/wait",
				sessionId: this.session.id,
				request: { cell_id: cellId, yield_time_ms: yieldTimeMs },
			});
			const outcome = runtimeOutcome(value);
			if (!outcome)
				throw new Error("Code host returned an invalid wait outcome");
			return parseRuntimeResponse(outcome);
		} finally {
			signal?.removeEventListener("abort", abort);
		}
	}

	async terminate(cellId: string): Promise<RuntimeResponse> {
		this.cancelCell(cellId);
		const value = await this.session.requestWithId(
			this.session.nextRequestId(),
			{
				method: "session/terminate",
				sessionId: this.session.id,
				cellId,
			},
		);
		const outcome = runtimeOutcome(value);
		if (!outcome)
			throw new Error("Code host returned an invalid termination outcome");
		return parseRuntimeResponse(outcome);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.clear();
		await this.session.shutdown();
	}

	private clear(): void {
		for (const pending of this.delegates.values()) pending.controller.abort();
		this.delegates.clear();
		this.cells.clear();
	}

	private cancelCell(cellId: string): void {
		for (const pending of this.delegates.values())
			if (pending.cellId === cellId) pending.controller.abort();
	}

	private handle(message: HostMessage): void {
		if (message.type === "delegate/cancel") {
			this.delegates.get(message.id)?.controller.abort();
		} else if (message.type === "cell/closed") {
			this.cancelCell(message.cellId);
			this.cells.delete(message.cellId);
		} else if (message.type === "delegate/request") {
			if (this.delegates.has(message.id))
				throw new Error(`Duplicate delegate request: ${message.id}`);
			const cellId =
				message.request.type === "notification/send"
					? message.request.cellId
					: message.request.invocation.cell_id;
			const controller = new AbortController();
			this.delegates.set(message.id, { cellId, controller });
			void this.invoke(message, controller.signal);
		}
	}

	private async invoke(
		message: DelegateRequestMessage,
		signal: AbortSignal,
	): Promise<void> {
		try {
			const request = message.request;
			const cellId =
				request.type === "notification/send"
					? request.cellId
					: request.invocation.cell_id;
			const cell = this.cells.get(cellId);
			if (!cell) throw new Error("Code cell is no longer available");
			signal.throwIfAborted();
			let value: unknown;
			if (request.type === "notification/send") {
				if (request.text === cell.yieldMarker) await cell.callbacks.yield?.();
				else await cell.callbacks.notify(request.text.slice(0, 16_384));
				value = { type: "notification/delivered" };
			} else {
				const tool = cell.tools.get(request.invocation.tool_name.name);
				if (!tool)
					throw new Error(`Unknown tool: ${request.invocation.tool_name.name}`);
				value = {
					type: "tool/result",
					result: await tool.invoke(
						request.invocation.input,
						signal,
						request.invocation.runtime_tool_call_id,
					),
				};
			}
			this.respond(message.id, { status: "ok", value });
		} catch (error) {
			this.respond(message.id, {
				status: "error",
				message: error instanceof Error ? error.message : String(error),
			});
		} finally {
			this.delegates.delete(message.id);
		}
	}

	private respond(id: number, result: unknown): void {
		try {
			this.session.send({ type: "delegate/response", id, result });
		} catch (error) {
			try {
				this.session.send({
					type: "delegate/response",
					id,
					result: {
						status: "error",
						message: `Tool result serialization failed: ${String(error)}`,
					},
				});
			} catch {
				/* Host teardown rejects owned execution. */
			}
		}
	}
}

/** Native globals normalize punctuation. Private transport names avoid collisions without renaming tools. */
function toolBootstrap(
	tools: readonly RuntimeTool[],
	yieldMarker: string,
): string {
	const entries = tools.map((tool, index) => [
		tool.name,
		`durable_tool_${index}`,
	]);
	const discovery = tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
	}));
	return `(()=>{const native=globalThis.tools;const registry=Object.create(null);for(const [name,wire] of ${JSON.stringify(entries)})registry[name]=native[wire];globalThis.tools=registry;globalThis.ALL_TOOLS=${JSON.stringify(discovery)};const emit=globalThis.notify;const yieldCell=globalThis.yield_control;globalThis.yield_control=()=>{emit(${JSON.stringify(yieldMarker)});return yieldCell();};})();`;
}
