import { type Context, copyJson } from "@earendil-works/chord";
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
import {
	directToolYieldTime,
	MAX_CODE_MODE_OUTPUT_TOKENS,
	readToolContract,
	toolValue,
} from "../../execution/src/index.ts";
import { ensureHost, type HostOptions } from "./binary.ts";
import { parseExecSource } from "./host-protocol.ts";
import { CodeHostRuntime } from "./host-runtime.ts";
import { runtimeResult } from "./result.ts";
import type {
	RuntimeContentItem,
	RuntimeResponse,
	RuntimeTool,
} from "./runtime-contract.ts";

interface Delivery {
	revision: number;
	delivered: boolean;
	promise: Promise<void>;
	release(): void;
}

/** One host session per conversation. Store/load cannot cross conversation boundaries. */
export class CodeEngine implements CellEngine {
	private readonly sessions = new Map<number, Promise<CodeHostRuntime>>();
	private readonly options: HostOptions;
	private readonly deliveries = new Map<number, Delivery>();
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
		const output: RuntimeContentItem[] = [];
		let remainingChars = maxTokens * 4;
		let imageChars = 0;
		let imageCount = 0;
		let omittedImages = 0;
		let truncated = false;
		let revision = 0;
		const notifications: RuntimeContentItem[] = [];
		const append = (items: RuntimeContentItem[]) => {
			for (const item of items) {
				if (item.type === "input_image") {
					if (
						imageCount >= 4 ||
						imageChars + item.image_url.length > 16 * 1024 * 1024
					) {
						omittedImages++;
					} else {
						output.push(item);
						imageCount++;
						imageChars += item.image_url.length;
					}
				} else if (item.text.length === 0) {
					continue;
				} else if (remainingChars > 0) {
					const text = item.text.slice(0, remainingChars);
					remainingChars -= text.length;
					output.push({ ...item, text });
					if (text.length < item.text.length && !truncated) {
						truncated = true;
						output.push({ type: "input_text", text: "[Output truncated]" });
					}
				} else if (!truncated) {
					truncated = true;
					output.push({ type: "input_text", text: "[Output truncated]" });
				}
			}
		};
		const traces: JsonObject[] = [];
		let droppedTraceCount = 0;
		let current: RuntimeResponse = {
			kind: "yielded",
			cellId: "pending",
			contentItems: output,
		};
		const result = (): ToolExecutionResult => {
			const result = runtimeResult(
				{
					...current,
					contentItems: [
						...output,
						...(omittedImages
							? [
									{
										type: "input_text" as const,
										text: `[${omittedImages} code-mode images omitted]`,
									},
								]
							: []),
					],
				},
				maxTokens,
			);
			return {
				...result,
				details: {
					runtimeCellId: current.cellId,
					status: current.kind,
					codeMode: true,
					traces: traces.map((trace) => ({ ...trace })),
					droppedTraceCount,
					deliveryRevision: revision,
					...(current.errorText ? { scriptError: current.errorText } : {}),
				},
			};
		};
		const publish = () => api.publish(result(), context);
		const tools: RuntimeTool[] = api.registrations.map(
			(registration, index) => ({
				name: registration.name,
				description: contracts[index]?.help ?? registration.description,
				inputSchema: contracts[index]?.inputSchema ?? registration.parameters,
				invoke: async (input, signal, callId) => {
					signal.throwIfAborted();
					const invoke = api.tools[registration.name];
					if (!invoke)
						throw new Error(`Tool ${registration.name} is unavailable`);
					// Preserve raw input so ordinary argument preparation runs before schema validation.
					const argumentsValue = copyJson(input ?? {});
					if (traces.length === 50) {
						traces.shift();
						droppedTraceCount++;
					}
					const trace: JsonObject = {
						id: callId,
						name: registration.name,
						input: JSON.stringify(argumentsValue).slice(0, 16_384),
						status: "running",
					};
					traces.push(trace);
					await publish();
					try {
						const value = await invoke(argumentsValue, signal);
						signal.throwIfAborted();
						const projected = toolValue(value);
						trace["status"] = "done";
						trace["result"] = JSON.stringify(value).slice(0, 16_384);
						await publish();
						return projected;
					} catch (error) {
						trace["status"] = "error";
						trace["error"] = (
							error instanceof Error ? error.message : String(error)
						).slice(0, 16_384);
						if (!api.signal.aborted) await publish();
						throw error;
					}
				},
			}),
		);
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
						notifications.push({ type: "input_text", text });
						if (notifications.length > 100) notifications.shift();
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
				output.length = 0;
				remainingChars = maxTokens * 4;
				imageChars = 0;
				imageCount = 0;
				omittedImages = 0;
				truncated = false;
				append([...notifications.splice(0), ...current.contentItems]);
				revision++;
				let release!: () => void;
				const promise = new Promise<void>((resolve) => {
					release = resolve;
				});
				const delivery: Delivery = {
					revision,
					delivered: false,
					promise,
					release,
				};
				this.deliveries.set(api.taskId, delivery);
				await publish();
				if (current.kind !== "yielded") return result();
				// Retain one complete bounded observation until its outer exec/wait has delivered it.
				// Draining further host output early would either lose it or create an unbounded backlog.
				if (output.length > 0)
					await awaitWithContext(delivery.promise, observationContext);
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
		const delivery = this.deliveries.get(taskId);
		if (!delivery || delivery.revision !== revision) return true;
		const fresh = !delivery.delivered;
		delivery.delivered = true;
		delivery.release();
		return fresh;
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
