import type { Context } from "@earendil-works/chord";
import type { ToolCall } from "@earendil-works/pi-ai";
import {
	type Agent,
	defineTask,
	type JsonObject,
	type ToolExecutionResult,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { Compile } from "typebox/compile";
import { forwardCall } from "./forwarding.ts";
import {
	boundResult,
	createInvocation,
	errorText,
	executionError,
	truncation,
} from "./invocation.ts";
import { InvocationDoc } from "./invocation-state.ts";
import {
	type Checkpoint,
	checked,
	eachHook,
	type NestedInput,
	nestedCall,
	type Runtime,
} from "./nested-call.ts";
import { interrupted, settle } from "./nested-result.ts";
import { readToolContract } from "./tool-contract.ts";
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
				await runtime.commit(async (tx) => {
					const doc = await tx.doc(InvocationDoc, runtime.taskId);
					if (task.input.cellId !== undefined)
						doc.forwardingCellId = task.input.cellId;
					await forwardCall(
						tx,
						task.input.cellId,
						{
							callId: call.id,
							parentCallId: call.parent?.callId ?? `nested-${runtime.taskId}`,
							name: call.name,
							arguments: task.input.arguments,
							status: "pending",
							result: null,
							omittedFields: [],
						},
						true,
					);
					return undefined;
				}, context);
				const agent = await runtime.agent(context);
				const tool = agent.callable.find((each) => each.name === call.name);
				if (tool === undefined || readToolContract(tool).nativeOnly)
					return reject(
						runtime,
						call,
						executionError(
							"tool_unavailable",
							`Tool ${call.name} is not available`,
						),
						agent,
						tool,
						context,
					);
				let args: JsonObject;
				try {
					// The V8 host encodes omitted input as null. Do not replace schema-valid nulls.
					const supplied =
						task.input.arguments === null &&
						!Compile(tool.parameters).Check(null) &&
						Compile(tool.parameters).Check({})
							? undefined
							: task.input.arguments;
					const prepared =
						tool.prepareArguments === undefined
							? supplied
							: tool.prepareArguments(supplied);
					args = checked(
						tool,
						call,
						prepared === undefined && Compile(tool.parameters).Check({})
							? {}
							: prepared,
					);
					if (
						task.input.arguments === null ||
						typeof task.input.arguments !== "object" ||
						Array.isArray(task.input.arguments)
					)
						call.arguments = args;
				} catch (error) {
					return reject(
						runtime,
						call,
						executionError("invalid_arguments", errorText(error)),
						agent,
						tool,
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
					return reject(
						runtime,
						call,
						executionError("blocked", `Tool call blocked: ${block}`),
						agent,
						tool,
						context,
					);
				try {
					args = checked(tool, call, args);
				} catch (error) {
					return reject(
						runtime,
						call,
						executionError("invalid_arguments", errorText(error)),
						agent,
						tool,
						context,
					);
				}
				await runtime.commit(async (tx) => {
					await tx.doc(InvocationDoc, runtime.taskId);
					await forwardCall(tx, task.input.cellId, {
						callId: call.id,
						parentCallId: call.parent?.callId ?? `nested-${runtime.taskId}`,
						name: call.name,
						arguments: args,
						status: "running",
						result: null,
						omittedFields: [],
					});
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
				const tool = agent.callable.find((each) => each.name === call.name);
				if (
					task.state.checkpoint.replay === "safe" &&
					tool?.replay === "safe" &&
					!readToolContract(tool).nativeOnly
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
				`Tool ${call.name} was aborted${task.state.checkpoint.phase === "execute" ? " and may have partially run" : ""}`,
				context,
			);
		},
	});
}

/** Rejected nested calls have no model round for afterTools; notify tool hooks here. */
async function reject(
	runtime: Runtime,
	call: ToolCall,
	result: ToolExecutionResult,
	agent: Agent,
	tool: ToolRegistration | undefined,
	context: Context,
): Promise<void> {
	await eachHook(agent, "afterTool", runtime, async (handler) => {
		result = (await handler(call, result, runtime, context)) ?? result;
	});
	await settle(
		runtime,
		call,
		finishResult(tool, call.name, result),
		"completed",
		context,
	);
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
		result.output === undefined &&
		finished.retained.droppedBytes > 0 &&
		final.output === finished.content
	) {
		final = {
			...final,
			diagnostics: [
				...(final.diagnostics ?? []),
				truncation(finished.retained, invocation?.limits.retain),
			],
		};
	}
	final = finishResult(tool, call.name, final);
	try {
		await settle(runtime, call, final, ending, context);
		for (const waiter of finished?.pending ?? []) waiter.resolve();
	} catch (error) {
		for (const waiter of finished?.pending ?? []) waiter.reject(error);
		throw error;
	}
}

/** Executed and rejected hook results cross the same output and schema boundary. */
function finishResult(
	tool: ToolRegistration | undefined,
	name: string,
	result: ToolExecutionResult,
): ToolExecutionResult {
	let final = boundResult(result, {
		maxBytes: tool?.outputLimits?.maxBytes ?? 50 * 1024,
		maxLines: tool?.outputLimits?.maxLines ?? 2_000,
		retain: tool?.outputLimits?.retain ?? "head",
	});
	try {
		if (tool?.structuredOutputSchema === undefined) {
			if (final.structuredOutput !== undefined)
				throw new Error(
					`Tool ${name} returned structuredOutput but declares no structuredOutputSchema`,
				);
		} else if (final.structuredOutput === undefined) {
			if (!final.isError)
				throw new Error(`Tool ${name} returned no structuredOutput`);
		} else if (
			!Compile(tool.structuredOutputSchema).Check(final.structuredOutput)
		) {
			throw new Error(
				`Tool ${name} returned structuredOutput that does not match its schema`,
			);
		}
	} catch (error) {
		const { structuredOutput: _invalid, ...rest } = final;
		final = {
			...rest,
			isError: true,
			diagnostics: [
				...(rest.diagnostics ?? []),
				{
					severity: "error",
					code: "invalid_structured_output",
					message: errorText(error),
				},
			],
		};
	}
	return final;
}
