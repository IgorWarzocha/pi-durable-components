/*
 * Background ownership and idempotent reporting adapted from Durable example 23.
 * MIT License
 * Copyright (c) 2025 Mario Zechner
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import type { Context } from "@earendil-works/chord";
import type {
	ConversationId,
	TaskId,
	TaskRuntime,
} from "@earendil-works/pi-durable";
import { defineTask } from "@earendil-works/pi-durable";
import type { WorkResult } from "./state.ts";
import { reportKey, submissionResult } from "./state.ts";

const completed = {
	status: "terminal",
	outcome: { status: "completed", result: null },
} as const;
const aborted = { status: "terminal", outcome: { status: "aborted" } } as const;
export const Anchor = defineTask<null, { phase: "done" }, null>({
	name: "howaboua.agents.anchor",
	version: 1,
	initial: () => ({ phase: "done" }),
	phases: {
		done: (_task, runtime, context) => runtime.commit(() => completed, context),
	},
	abort: (_task, runtime, context) => runtime.commit(() => aborted, context),
});

type DispatchInput = {
	target: ConversationId;
	message: string;
	controller: ConversationId;
};
export const Dispatch = defineTask<DispatchInput, { phase: "run" }, WorkResult>(
	{
		name: "howaboua.agents.dispatch",
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: {
			run: async (task, runtime, context) => {
				const child = await runtime.conversation(task.input.target, context);
				if (child === undefined)
					throw new Error(`Missing agent ${task.input.target}`);
				const submission = await child.submit(
					{
						type: "input",
						content: `[Task from conversation ${task.input.controller}]\n${task.input.message}`,
						requestId: `agents:work:${task.id}`,
						whenBusy: "steer",
					},
					context,
				);
				const settled = await submission.wait(context);
				await runtime.commit(async (tx) => {
					const result = await submissionResult(tx, task.input.target, settled);
					return {
						status: "terminal",
						outcome: { status: "completed", result },
					};
				}, context);
			},
		},
		abort: (_task, runtime, context) => runtime.commit(() => aborted, context),
	},
);

type CompletionInput = {
	dispatch: TaskId<WorkResult>;
	caller: TaskId;
	blocking: boolean;
	target: ConversationId;
};
type CompletionState =
	| { phase: "wait" }
	| { phase: "report"; result: WorkResult };
export const Completion = defineTask<CompletionInput, CompletionState, null>({
	name: "howaboua.agents.completion",
	version: 1,
	initial: () => ({ phase: "wait" }),
	phases: {
		wait: async (task, runtime, context) => {
			const receipt = await runtime.waitForTask(task.input.dispatch, context);
			// Blocking tool cancellation detaches only its waiter. Report after that tool settles.
			if (task.input.blocking) {
				const caller = await runtime.waitForTask(task.input.caller, context);
				if (caller.state.outcome.status === "completed") {
					await runtime.commit(() => completed, context);
					return;
				}
			}
			const result: WorkResult =
				receipt.state.outcome.status === "completed"
					? receipt.state.outcome.result
					: {
							target: task.input.target,
							status: "failed",
							reply: "",
							reason: receipt.state.outcome.status,
						};
			await runtime.commit(
				() => ({ status: "running", checkpoint: { phase: "report", result } }),
				context,
			);
		},
		report: async (task, runtime, context) => {
			await deliver(
				runtime,
				task.state.checkpoint.result,
				task.input.dispatch,
				context,
			);
			await runtime.commit(() => completed, context);
		},
	},
	abort: (_task, runtime, context) => runtime.commit(() => aborted, context),
});

export async function deliver<I, S, R>(
	runtime: TaskRuntime<I, S, R, object>,
	result: WorkResult,
	fallback: TaskId,
	context: Context,
): Promise<void> {
	const controller = await runtime.conversation(
		runtime.conversationId,
		context,
	);
	if (controller === undefined)
		throw new Error(`Missing controller ${runtime.conversationId}`);
	await controller.submit(
		{
			type: "input",
			content: `[Agent result] ${JSON.stringify({ ...result, target: String(result.target), taskId: fallback })}`,
			whenBusy: "followUp",
			requestId: reportKey(runtime.conversationId, result, fallback),
		},
		context,
	);
}
