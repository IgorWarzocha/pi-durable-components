import type { Context } from "@earendil-works/chord";
import type {
	ConversationId,
	InputSubmissionDraft,
	SubmissionId,
	SubmissionRecord,
	TaskId,
} from "@earendil-works/pi-durable";
import { ConversationBusy, defineTask } from "@earendil-works/pi-durable";
import {
	Admission,
	type ContextHost,
	Continuation,
	cancelHeldInputs,
	cancelPlacedInput,
	conversation,
	foreignTasks,
	IDLE_MS,
	INPUT_TASK,
	type InputResult,
	nativeIdle,
	releaseAdmission,
	until,
} from "./lifecycle.ts";
import {
	type createRollover,
	scheduleRollover,
	transitionResult,
} from "./rollover.ts";
import {
	latestUserEntry,
	type TransitionResult,
	WindowState,
} from "./window-state.ts";

type InputState =
	| { phase: "admit"; checkpointRequired?: true }
	| { phase: "blocked"; retry: number; reason: string }
	| { phase: "observe"; submission: SubmissionId };

export function createInput(
	host: () => ContextHost,
	rollover: ReturnType<typeof createRollover>,
) {
	return defineTask<InputSubmissionDraft, InputState, InputResult>({
		name: INPUT_TASK,
		version: 1,
		initial: () => ({ phase: "admit" }),
		phases: {
			admit: async (task, runtime, context) => {
				await until(
					await runtime.watchDoc(Admission, task.conversationId, context),
					(state) =>
						state.queue[0] === task.id || state.cancelled.includes(task.id),
					runtime.signal,
				);
				if (
					(
						await runtime.snapshot(Admission, task.conversationId, context)
					)?.cancelled.includes(task.id)
				) {
					await runtime.commit(async (tx) => {
						await releaseAdmission(tx, task.conversationId, task.id);
						return { status: "terminal", outcome: { status: "aborted" } };
					}, context);
					return;
				}
				const conv = await conversation(host(), task.conversationId, context);
				const decision = await conv.commit(async (tx) => {
					const userEntry = await latestUserEntry(tx, conv.id);
					const idle = await nativeIdle(tx, conv.id);
					const tasks = await foreignTasks(tx, conv.id);
					const state = await tx.doc(WindowState, conv.id);
					const gate = await tx.doc(Admission, conv.id);
					const due =
						idle &&
						tasks.length === 0 &&
						state.settlement !== undefined &&
						state.settlement.userEntry === userEntry &&
						runtime.now() - state.settlement.observedAt >= IDLE_MS;
					const transition =
						state.transition ??
						(due || task.state.checkpoint.checkpointRequired
							? await scheduleRollover(tx, conv.id, rollover, "idle", task.id)
							: undefined);
					return { transition, retry: gate.retry };
				}, context);
				if (decision.transition) {
					const result = await transitionResult(
						host(),
						decision.transition,
						context,
					);
					if (result.status === "cancelled") {
						// A cancelled checkpoint cancels every held message, rather than silently trying another checkpoint.
						await runtime.commit(async (tx) => {
							await cancelHeldInputs(tx, conv.id);
							await releaseAdmission(tx, conv.id, task.id);
							return { status: "terminal", outcome: { status: "aborted" } };
						}, context);
						return;
					}
					if (result.status === "failed") {
						await runtime.commit(async (tx) => {
							const gate = await tx.doc(Admission, conv.id);
							gate.blocked = { task: task.id, reason: result.reason };
							return {
								status: "running",
								checkpoint: {
									phase: "blocked",
									retry: decision.retry,
									reason: result.reason,
								},
							};
						}, context);
						return;
					}
				}
				let submission;
				try {
					submission = await conv.submit(
						{ ...task.input, requestId: `context:input:${task.id}` },
						context,
					);
				} catch (error) {
					if (!(error instanceof ConversationBusy)) throw error;
					await runtime.commit(async (tx) => {
						await releaseAdmission(tx, conv.id, task.id);
						return {
							status: "terminal",
							outcome: { status: "failed", error: { message: error.message } },
						};
					}, context);
					return;
				}
				await runtime.commit(async (tx) => {
					await releaseAdmission(tx, conv.id, task.id);
					return {
						status: "running",
						checkpoint: { phase: "observe", submission: submission.id },
					};
				}, context);
			},
			blocked: async (task, runtime, context) => {
				await until(
					await runtime.watchDoc(Admission, task.conversationId, context),
					(gate) =>
						gate.retry > task.state.checkpoint.retry ||
						gate.cancelled.includes(task.id),
					runtime.signal,
				);
				await runtime.commit(async (tx) => {
					const gate = await tx.doc(Admission, task.conversationId);
					if (gate.cancelled.includes(task.id)) {
						await releaseAdmission(tx, task.conversationId, task.id);
						return { status: "terminal", outcome: { status: "aborted" } };
					}
					if (gate.blocked?.task === task.id) delete gate.blocked;
					return {
						status: "running",
						checkpoint: { phase: "admit", checkpointRequired: true },
					};
				}, context);
			},
			observe: async (task, runtime, context) => {
				const submission = await host().harness.submission(
					task.state.checkpoint.submission,
					context,
				);
				if (!submission) throw new Error("Managed input submission is missing");
				const settled = await submission.wait(context);
				if (settled.type !== "input")
					throw new Error("Managed submission is not an input");
				const continuation = await runtime.snapshot(
					Continuation,
					task.conversationId,
					String(submission.id),
					context,
				);
				if (continuation?.task) {
					const result = await transitionResult(
						host(),
						continuation.task,
						context,
					);
					if (result.status === "done" && result.continuation !== undefined) {
						const next = result.continuation;
						await runtime.commit(
							() => ({
								status: "running",
								checkpoint: { phase: "observe", submission: next },
							}),
							context,
						);
						return;
					}
					await runtime.commit(
						() => ({
							status: "terminal",
							outcome: {
								status: "failed",
								error: {
									message:
										result.status === "failed"
											? result.reason
											: "Context continuation was cancelled",
								},
							},
						}),
						context,
					);
					return;
				}
				await runtime.commit(async (tx) => {
					const userEntry = await latestUserEntry(tx, task.conversationId);
					const idle = await nativeIdle(tx, task.conversationId);
					const state = await tx.doc(WindowState, task.conversationId);
					// This is observation time, not a provider timestamp. Recovery can delay, never advance, the idle cut.
					if (idle && !state.transition)
						state.settlement = { observedAt: runtime.now(), userEntry };
					const result: InputResult =
						settled.status === "done"
							? {
									status: "done",
									answer: settled.answer,
									submission: submission.id,
								}
							: {
									status: "unanswered",
									reason: settled.reason,
									submission: submission.id,
									...(settled.detail === undefined
										? {}
										: { detail: settled.detail }),
								};
					return {
						status: "terminal",
						outcome: { status: "completed", result },
					};
				}, context);
			},
		},
		abort: async (task, runtime, context) => {
			const binding = host();
			const conv = await conversation(binding, task.conversationId, context);
			const original = await conv.commit(
				(tx) => tx.submissionByRequest(conv.id, `context:input:${task.id}`),
				context,
			);
			const submission =
				task.state.checkpoint.phase === "observe"
					? task.state.checkpoint.submission
					: original?.id;
			if (submission !== undefined)
				await cancelContinuation(binding, conv.id, submission, context);
			// Join an owned idle rollover before releasing the admission gate. Its abort marks the held queue.
			const window = await runtime.snapshot(WindowState, conv.id, context);
			if (window?.transition) {
				const transition = await runtime.getTask(window.transition, context);
				if (transition?.owner === task.id) {
					await binding.harness.abortTask(transition.id, context);
					await binding.harness.waitForTask(transition.id, context);
				}
			}
			await runtime.commit(async (tx) => {
				await releaseAdmission(tx, task.conversationId, task.id);
				return { status: "terminal", outcome: { status: "aborted" } };
			}, context);
		},
	});
}

/** Follow durable handoff receipts even when abort lands between continuation admission and observation. */
async function cancelContinuation(
	host: ContextHost,
	id: ConversationId,
	first: SubmissionId,
	context: Context,
): Promise<void> {
	const conv = await conversation(host, id, context);
	let current: SubmissionId | undefined = first;
	while (current !== undefined) {
		await host.harness.abortSubmission(current, context, id);
		await cancelPlacedInput(host, conv, current, context);
		const link: { readonly task?: TaskId<TransitionResult> } | undefined =
			await host.harness.snapshot(Continuation, id, String(current), context);
		if (!link?.task) return;
		await host.harness.abortTask(link.task, context);
		await host.harness.waitForTask(link.task, context);
		const next: SubmissionRecord | undefined = await conv.commit(
			(tx) => tx.submissionByRequest(id, `context:continue:${link.task}`),
			context,
		);
		current = next?.id;
	}
}
