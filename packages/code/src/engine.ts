import { type Context } from "@earendil-works/chord";
import {
	awaitWithContext,
	withAbortSignal,
} from "@earendil-works/chord/context";
import type {
	JsonObject,
	ToolExecutionResult,
} from "@earendil-works/pi-durable";
import type {
	CellEngine,
	CellEngineApi,
} from "../../execution/src/cell-contract.ts";
import { parseExecSource } from "../../execution/src/exec-source.ts";
import {
	directToolYieldTime,
	MAX_CODE_MODE_OUTPUT_TOKENS,
	readToolContract,
} from "../../execution/src/index.ts";
import { ensureHost, type HostOptions } from "./binary.ts";
import { CodeCellOutput } from "./cell-output.ts";
import { CodeHostRuntime } from "./host-runtime.ts";
import type { RuntimeResponse } from "./runtime-contract.ts";
import { runtimeTools } from "./runtime-tools.ts";

/** One host session per conversation. Store/load cannot cross conversation boundaries. */
export class CodeEngine implements CellEngine {
	private readonly sessions = new Map<number, Promise<CodeHostRuntime>>();
	private readonly options: HostOptions;
	private readonly deliveries = new Map<number, CodeCellOutput>();
	private closed = false;
	constructor(options: HostOptions = {}) {
		this.options = options;
	}

	async run(
		input: JsonObject,
		api: CellEngineApi,
		context: Context,
	): Promise<ToolExecutionResult> {
		if (this.closed) throw new Error("Code component is closed");
		if (typeof input["code"] !== "string")
			throw new Error("exec requires JavaScript source in code");
		const source = input["code"];
		const parsed = parseExecSource(source);
		// The outer exec/wait applies its own requested budget. Retain the maximum legal
		// observation so a later wait can ask for more than the original exec requested.
		const maxTokens = MAX_CODE_MODE_OUTPUT_TOKENS;
		const contracts = api.registrations.map(readToolContract);
		const initialYieldMs =
			directToolYieldTime(parsed.code, contracts) ??
			parsed.yieldTimeMs ??
			30_000;
		const key = api.conversationId;
		let session = this.sessions.get(key);
		if (!session) {
			session = ensureHost(this.options, api.signal).then(
				(binary) => new CodeHostRuntime(binary),
			);
			this.sessions.set(key, session);
			void session.catch(() => {
				if (this.sessions.get(key) === session) this.sessions.delete(key);
			});
		}
		const runtime = await session;
		if (this.closed) {
			await runtime.close();
			throw new Error("Code component is closed");
		}
		api.signal.throwIfAborted();
		const observationContext = withAbortSignal(
			AbortSignal.any([api.signal, runtime.failureSignal]),
			context,
		);
		let nativeId: string | undefined;
		const observation = new CodeCellOutput(maxTokens);
		const result = () => observation.result();
		const publish = () => api.publish(result(), context);
		const tools = runtimeTools(api, contracts, observation, context);
		let current: RuntimeResponse;
		let termination: Promise<RuntimeResponse> | undefined;
		const abort = () => {
			if (nativeId) {
				termination = runtime.terminate(nativeId);
				void termination.catch(() => undefined);
			}
		};
		api.signal.addEventListener("abort", abort, { once: true });
		try {
			current = await runtime.execute(
				source,
				tools,
				{
					notify: async (text) => {
						observation.notify(text);
						await publish();
					},
					yield: () => api.requestYield(context),
				},
				api.signal,
				(cellId) => {
					nativeId = cellId;
				},
				initialYieldMs,
			);
			for (;;) {
				observation.replaceObservation(current);
				this.deliveries.set(api.taskId, observation);
				await publish();
				if (current.kind !== "yielded") return result();
				// Retain one complete bounded observation until its outer exec/wait has delivered it.
				// Draining further host output early would either lose it or create an unbounded backlog.
				if (observation.hasOutput)
					await awaitWithContext(observation.delivered, observationContext);
				current = await runtime.wait(current.cellId, 30_000, api.signal);
			}
		} catch (error) {
			if (api.signal.aborted) throw error;
			return {
				...result(),
				isError: true,
				diagnostics: [
					{
						severity: "error",
						code: "interrupted",
						message: `Code execution was interrupted: ${error instanceof Error ? error.message : String(error)}. Operations may already have executed. Code was not replayed`,
					},
				],
			};
		} finally {
			api.signal.removeEventListener("abort", abort);
			this.deliveries.delete(api.taskId);
			// Native termination must drain before this owned driver invocation ends.
			await termination?.catch(() => undefined);
		}
	}

	/** Ack only the exact snapshot delivered. Repeated running observations must not repeat its content. */
	acknowledge(taskId: number, revision: number): boolean {
		return this.deliveries.get(taskId)?.acknowledge(revision) ?? true;
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		const sessions = [...this.sessions.values()];
		this.sessions.clear();
		await Promise.all(
			sessions.map(async (session) => {
				await (await session).close();
			}),
		);
	}
}
