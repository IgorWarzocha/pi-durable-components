import type { Context } from "@earendil-works/chord";
import type { ToolCall } from "@earendil-works/pi-ai";
import {
	type Agent,
	defineTask,
	type JsonObject,
	type ToolExecutionResult,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import {
	boundResult,
	createInvocation,
	errorText,
	executionError,
	InvocationDoc,
	truncation,
} from "./invocation.ts";
import {
	type Checkpoint,
	checked,
	eachHook,
	type NestedInput,
	nestedCall,
	type Runtime,
} from "./nested-call.ts";
import { interrupted, settle } from "./nested-result.ts";
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
