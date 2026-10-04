import { type Context, copyJson, type JsonValue } from "@earendil-works/chord";
import type { ToolCall, Usage } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import {
	type Agent,
	defineEntry,
	defineTask,
	type HookApi,
	type JsonObject,
	type TaskRuntime,
	type ToolExecutionResult,
	type ToolHooks,
	type ToolRegistration,
	ToolTask,
	UsageDoc,
} from "@earendil-works/pi-durable";
import {
	boundResult,
	createInvocation,
	errorText,
	executionError,
	InvocationDoc,
	storeResult,
	truncation,
} from "./invocation.ts";

type NestedInput = { name: string; arguments: JsonValue };
type Checkpoint =
	| { phase: "call" }
	| { phase: "execute"; arguments: JsonObject; replay: "safe" | "unsafe" };
type Runtime = TaskRuntime<
	NestedInput,
	Checkpoint,
	ToolExecutionResult,
	Record<string, never>
>;
/** An audit record, deliberately with no assistant or tool-result model contribution. */
const NestedResultEntry = defineEntry<JsonObject>(
	"howaboua.execution.nested-result",
);

export function createNestedToolTask(name: string) {
	return defineTask<
		NestedInput,
		Checkpoint,
		ToolExecutionResult,
		Record<string, never>
	>({
		name,
		version: 1,
		initial: () => ({ phase: "call" }),
		phases: {
			call: async (task, runtime, context) => {
				const call = nestedCall(runtime, task.input);
				const agent = await runtime.agent(context);
				const tool = agent.tools.find((each) => each.name === call.name);
				if (tool === undefined)
					return settle(
						runtime,
						call,
						executionError(
							"tool_unavailable",
							`Tool ${call.name} is not available`,
						),
						"completed",
						context,
					);
				let args: JsonObject;
				try {
					args = checked(
						tool,
						call,
						tool.prepareArguments === undefined
							? task.input.arguments
							: tool.prepareArguments(task.input.arguments),
					);
					if (
						task.input.arguments === null ||
						typeof task.input.arguments !== "object" ||
						Array.isArray(task.input.arguments)
					)
						call.arguments = args;
				} catch (error) {
					return settle(
						runtime,
						call,
						executionError("invalid_arguments", errorText(error)),
						"completed",
						context,
					);
				}
				let block: string | undefined;
				await eachHook(agent, "beforeTool", runtime, async (handler) => {
					if (block !== undefined) return;
					try {
						const decision = await handler(
							{ ...call, arguments: args },
							runtime,
							context,
						);
						if (decision?.block !== undefined) block = decision.block;
						else if (decision?.arguments !== undefined)
							args = decision.arguments;
					} catch (error) {
						if (runtime.signal.aborted) throw error;
						block = errorText(error);
					}
				});
				if (block !== undefined)
					return settle(
						runtime,
						call,
						executionError("blocked", `Tool call blocked: ${block}`),
						"completed",
						context,
					);
				try {
					args = checked(tool, call, args);
				} catch (error) {
					return settle(
						runtime,
						call,
						executionError("invalid_arguments", errorText(error)),
						"completed",
						context,
					);
				}
				await runtime.commit(async (tx) => {
					await tx.doc(InvocationDoc, runtime.taskId);
					return {
						status: "running",
						checkpoint: {
							phase: "execute",
							arguments: args,
							replay: tool.replay ?? "unsafe",
						},
					};
				}, context);
				await run(runtime, call, tool, args, agent, context);
			},
			execute: async (task, runtime, context) => {
				const call = nestedCall(runtime, task.input);
				if (
					task.input.arguments === null ||
					typeof task.input.arguments !== "object" ||
					Array.isArray(task.input.arguments)
				)
					call.arguments = task.state.checkpoint.arguments;
				const agent = await runtime.agent(context);
				const tool = agent.tools.find((each) => each.name === call.name);
				if (
					task.state.checkpoint.replay === "safe" &&
					tool?.replay === "safe"
				) {
					await runtime.commit(async (tx) => {
						const doc = await tx.doc(InvocationDoc, runtime.taskId);
						doc.result = {};
						doc.droppedBytes = 0;
						doc.droppedLines = 0;
						return undefined;
					}, context);
					return run(
						runtime,
						call,
						tool,
						task.state.checkpoint.arguments,
						agent,
						context,
					);
				}
				await interrupted(
					runtime,
					call,
					"interrupted",
					`Tool ${call.name} was interrupted and may have partially run`,
					context,
				);
			},
		},
		abort: async (task, runtime, context) => {
			const call = nestedCall(runtime, task.input);
			await interrupted(
				runtime,
				call,
				"aborted",
				`Tool ${call.name} was aborted`,
				context,
			);
		},
	});
}

function nestedCall(runtime: Runtime, input: NestedInput): ToolCall {
	const args = input.arguments;
	return {
		type: "toolCall",
		id: `nested-${runtime.taskId}`,
		name: input.name,
		arguments:
			args !== null && typeof args === "object" && !Array.isArray(args)
				? args
				: {},
	};
}

function checked(
	tool: ToolRegistration,
	call: ToolCall,
	args: unknown,
): JsonObject {
	return validateToolArguments(tool, {
		...call,
		arguments: args as JsonObject,
	}) as JsonObject;
}

/** Public hook registrations erase their handler type. Select by the built-in task name before restoring it. */
async function eachHook<K extends keyof ToolHooks>(
	agent: Agent,
	name: K,
	api: HookApi & { signal: AbortSignal; report(error: unknown): void },
	invoke: (hook: ToolHooks[K]) => Promise<void>,
): Promise<void> {
	for (const extension of agent.extensions)
		for (const registration of extension.hooks ?? []) {
			if (registration.task !== ToolTask.definition.name) continue;
			const handler = (registration.handlers as Partial<ToolHooks>)[name];
			if (handler === undefined) continue;
			try {
				await invoke(handler);
			} catch (error) {
				if (api.signal.aborted) throw error;
				api.report(error);
			}
		}
}

async function run(
	runtime: Runtime,
	call: ToolCall,
	tool: ToolRegistration,
	args: JsonObject,
	agent: Agent,
	context: Context,
): Promise<void> {
	let invocation: Awaited<ReturnType<typeof createInvocation>> | undefined;
	let result: ToolExecutionResult;
	let ending: "completed" | "failed" = "completed";
	try {
		invocation = createInvocation(runtime, tool, context);
		result = await tool.execute(args, await invocation.executionApi(), context);
	} catch (error) {
		if (runtime.signal.aborted) {
			await invocation?.stop(error);
			throw error;
		}
		result = {
			isError: true,
			diagnostics: [
				{ severity: "error", code: "tool_error", message: errorText(error) },
			],
		};
		ending = "failed";
	}
	const finished = await invocation?.finish(result);
	let final = finished?.result ?? result;
	await eachHook(agent, "afterTool", runtime, async (handler) => {
		final = (await handler(call, final, runtime, context)) ?? final;
	});
	if (
		finished !== undefined &&
		result.content === undefined &&
		finished.retained.droppedBytes > 0 &&
		final.content === finished.content
	) {
		final = {
			...final,
			diagnostics: [
				...(final.diagnostics ?? []),
				truncation(finished.retained, invocation?.limits.retain),
			],
		};
	}
	if (invocation !== undefined) final = boundResult(final, invocation.limits);
	try {
		await settle(runtime, call, final, ending, context);
		for (const waiter of finished?.pending ?? []) waiter.resolve();
	} catch (error) {
		for (const waiter of finished?.pending ?? []) waiter.reject(error);
		throw error;
	}
}

async function interrupted(
	runtime: Runtime,
	call: ToolCall,
	code: "interrupted" | "aborted",
	message: string,
	context: Context,
): Promise<void> {
	const state = await runtime.snapshot(InvocationDoc, runtime.taskId, context);
	const partial = state?.result ?? {};
	const diagnostics = [...(partial.diagnostics ?? [])];
	if ((state?.droppedBytes ?? 0) > 0)
		diagnostics.push(
			truncation({
				droppedBytes: state?.droppedBytes ?? 0,
				droppedLines: state?.droppedLines ?? 0,
			}),
		);
	await settle(
		runtime,
		call,
		{
			...partial,
			isError: true,
			diagnostics: [
				...diagnostics,
				...(executionError(code, message).diagnostics ?? []),
			],
		},
		code === "aborted" ? "aborted" : "failed",
		context,
	);
}

async function settle(
	runtime: Runtime,
	call: ToolCall,
	result: ToolExecutionResult,
	ending: "completed" | "failed" | "aborted",
	context: Context,
): Promise<void> {
	const stored = storeResult(result);
	await runtime.commit(async (tx, current) => {
		(await tx.doc(InvocationDoc, runtime.taskId)).result = stored;
		await tx.appendEntry(NestedResultEntry, runtime.conversationId, {
			data: {
				taskId: runtime.taskId,
				callId: call.id,
				name: call.name,
				arguments: copyJson(call.arguments),
				result: stored,
				...(current.state.checkpoint.phase === "execute"
					? {
							intent: {
								arguments: copyJson(current.state.checkpoint.arguments),
								replay: current.state.checkpoint.replay,
							},
						}
					: {}),
			},
		});
		if (result.usage !== undefined) {
			const totals = (await tx.doc(UsageDoc, runtime.conversationId)).tools;
			const previous = Object.hasOwn(totals, call.name)
				? totals[call.name]
				: undefined;
			totals[call.name] = copyJson(
				previous === undefined
					? result.usage
					: sumUsage(previous, result.usage),
				{ omitUndefinedProperties: true },
			) as NonNullable<typeof previous>;
		}
		const outcome =
			ending === "completed"
				? { status: ending, result: stored }
				: ending === "aborted"
					? { status: ending, result: stored }
					: {
							status: ending,
							error: {
								message: `Tool ${call.name} ${result.diagnostics?.at(-1)?.code === "interrupted" ? "was interrupted" : "threw"}`,
							},
							result: stored,
						};
		return { status: "terminal", outcome };
	}, context);
}

function sumUsage(previous: Usage, added: Usage): Usage {
	return {
		input: previous.input + added.input,
		output: previous.output + added.output,
		cacheRead: previous.cacheRead + added.cacheRead,
		cacheWrite: previous.cacheWrite + added.cacheWrite,
		totalTokens: previous.totalTokens + added.totalTokens,
		...(previous.cacheWrite1h === undefined && added.cacheWrite1h === undefined
			? {}
			: {
					cacheWrite1h:
						(previous.cacheWrite1h ?? 0) + (added.cacheWrite1h ?? 0),
				}),
		...(previous.reasoning === undefined && added.reasoning === undefined
			? {}
			: { reasoning: (previous.reasoning ?? 0) + (added.reasoning ?? 0) }),
		cost: {
			input: previous.cost.input + added.cost.input,
			output: previous.cost.output + added.cost.output,
			cacheRead: previous.cost.cacheRead + added.cost.cacheRead,
			cacheWrite: previous.cost.cacheWrite + added.cost.cacheWrite,
			total: previous.cost.total + added.cost.total,
		},
	};
}
