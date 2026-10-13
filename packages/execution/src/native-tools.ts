import { type Context, copyJson } from "@earendil-works/chord";
import {
	type JsonObject,
	LiveDoc,
	NestedCallDoc,
	type NestedToolExecutionResult,
	type TaskId,
	type TaskRuntime,
	type ToolExecutionApi,
	ToolTask,
	type ToolTaskInput,
} from "@earendil-works/pi-durable";
import { Equal } from "typebox/value";

export function nativeToolCalls<I, S, R, H extends object>(
	runtime: TaskRuntime<I, S, R, H>,
	callId: string,
	replay: "safe" | "unsafe" | undefined,
	assertLive: () => void,
	context: Context,
) {
	let sequence = 0;
	const admissions: Promise<unknown>[] = [];
	const execute: ToolExecutionApi["executeTool"] = async (
		name,
		args,
		callContext,
		options = {},
	) => {
		assertLive();
		const key = options.key ?? String(++sequence);
		if (
			options.key !== undefined &&
			(!key ||
				key.includes("/") ||
				key === "__proto__" ||
				/^[1-9][0-9]*$/.test(key))
		)
			throw new Error("Invalid nested call key");
		const call = {
			type: "toolCall" as const,
			id: `${callId}/${key}`,
			name,
			arguments: copyJson(args, {
				omitUndefinedProperties: true,
			}) as JsonObject,
		};
		const admission = runtime.commit(async (tx) => {
			const slot = await tx.doc(NestedCallDoc, runtime.taskId, key, null);
			if (slot.taskId !== undefined) {
				const input = (await tx.task(slot.taskId))?.input as
					| ToolTaskInput
					| undefined;
				if (
					input?.kind !== "nested" ||
					input.call.name !== name ||
					!Equal(input.call.arguments, call.arguments)
				)
					throw new Error(
						`Nested call ${call.id} was already made with another tool or other arguments`,
					);
			} else {
				slot.taskId = await tx.createTask(
					ToolTask,
					{
						kind: "nested",
						parent: runtime.taskId,
						parentCallId: callId,
						key,
						call,
						...(options.progress === false ? { progress: false } : {}),
					},
					{
						ownership: { kind: "task", taskId: runtime.taskId },
						abandonOnRestart: replay !== "safe",
					},
				);
				const live = await tx.doc(LiveDoc, runtime.conversationId);
				live.nestedTools ??= [];
				live.nestedTools.push({
					callId: call.id,
					parentCallId: callId,
					parentTaskId: runtime.taskId,
					name,
					taskId: slot.taskId,
					arguments: call.arguments,
					status: "pending",
				});
			}
			return undefined;
		}, callContext);
		admissions.push(admission);
		await admission;
		const slot = await runtime.snapshot(
			NestedCallDoc,
			runtime.taskId,
			key,
			callContext,
		);
		if (slot?.taskId === undefined)
			throw new Error("Nested task creation did not commit");
		const settled = await runtime.waitForTask(slot.taskId, callContext);
		const result = (
			await runtime.snapshot(NestedCallDoc, runtime.taskId, key, callContext)
		)?.result;
		return result === undefined
			? {
					taskId: slot.taskId,
					isError: true,
					diagnostics: [
						{
							severity: "error",
							code: settled.state.outcome.status,
							message: `Tool ${name} did not return a result`,
						},
					],
				}
			: (copyJson(result) as unknown as NestedToolExecutionResult);
	};
	return {
		execute,
		async finish() {
			await Promise.allSettled(admissions);
			await cleanupNativeCalls(runtime, context);
		},
	};
}

/** Custom cell callers own native nested slots too, including after recovery. */
export async function cleanupNativeCalls<I, S, R, H extends object>(
	runtime: TaskRuntime<I, S, R, H>,
	context: Context,
): Promise<void> {
	await Promise.all(
		(await runtime.ownedTasks(context))
			.filter((child) => child.kind === ToolTask.definition.name)
			.map((child) => runtime.abortOwned(child.id, context)),
	);
	await runtime.commit(async (tx) => {
		const live = await tx.doc(LiveDoc, runtime.conversationId);
		const removed = new Set<TaskId>([runtime.taskId]);
		for (const slot of live.nestedTools ?? [])
			if (removed.has(slot.parentTaskId)) removed.add(slot.taskId);
		if (live.nestedTools !== undefined) {
			live.nestedTools = live.nestedTools.filter(
				(slot) => !removed.has(slot.parentTaskId),
			);
			if (!live.nestedTools.length) delete live.nestedTools;
		}
		return undefined;
	}, context);
}
