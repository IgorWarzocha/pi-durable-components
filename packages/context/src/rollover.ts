import type { Context } from "@earendil-works/chord";
import type {
	ConversationId,
	Cursor,
	SubmissionId,
	TaskId,
	Tx,
} from "@earendil-works/pi-durable";
import { defineTask } from "@earendil-works/pi-durable";
import {
	type ContextHost,
	cancelHeldInputs,
	cancelInput,
	conversation,
	foreignTasks,
	nativeIdle,
	ROLLOVER_TASK,
} from "./lifecycle.ts";
import { notesAreFresh } from "./note-store.ts";
import {
	latestUserEntry,
	type TransitionResult,
	WindowEntry,
	type WindowIdentity,
	WindowState,
} from "./window-state.ts";

type RolloverInput = {
	reason: "idle" | "manual" | "tool";
	continue: boolean;
	windowId: string;
};
type RolloverState =
	| { phase: "prepare" }
	| { phase: "checkpoint"; submission: SubmissionId }
	| { phase: "rotate" }
	| { phase: "continue"; window: WindowIdentity };

const checkpointPrompt =
	"Checkpoint this conversation before a clean context window. Write the current task, decisions, useful evidence and next steps to notes. Save only useful state, then finish this turn. Do not call new_context.";
const key = (task: TaskId) => `context:checkpoint:${task}`;

/** A successful note write in an aborted generation is not a completed checkpoint. */
async function completedFreshNotes(
	host: ContextHost,
	id: ConversationId,
	context: Context,
): Promise<boolean> {
	const conv = await conversation(host, id, context);
	const state = await conv.commit(
		async (tx) => ({
			fresh: await notesAreFresh(tx, id),
			user: await latestUserEntry(tx, id),
		}),
		context,
	);
	if (!state.fresh || state.user === null) return false;
	let cursor: Cursor | undefined;
	let newest = 0;
	let done = false;
	do {
		const page = await host.storage.scanSubmissions(
			{ conversationId: id },
			64,
			cursor,
			context,
		);
		for (const submission of page.items) {
			if (
				submission.type !== "input" ||
				submission.entry === undefined ||
				submission.entry > state.user ||
				submission.entry <= newest
			)
				continue;
			newest = submission.entry;
			// onYield continuations are user entries without their own submissions.
			done = submission.status === "done" && submission.answer > state.user;
		}
		cursor = page.next;
	} while (cursor !== undefined);
	return done;
}

export function createRollover(host: () => ContextHost) {
	return defineTask<RolloverInput, RolloverState, TransitionResult>({
		name: ROLLOVER_TASK,
		version: 1,
		initial: () => ({ phase: "prepare" }),
		phases: {
			prepare: async (task, runtime, context) => {
				const conv = await conversation(host(), task.conversationId, context);
				// Native generations and foreground cells must finish without waiting on their managed parent.
				for (;;) {
					const tasks = await conv.commit(
						(tx) => foreignTasks(tx, conv.id),
						context,
					);
					if (!tasks.length) break;
					await Promise.all(
						tasks.map((id) => runtime.waitForTask(id, context)),
					);
				}
				const fresh = await completedFreshNotes(host(), conv.id, context);
				if (fresh) {
					await runtime.commit(
						() => ({ status: "running", checkpoint: { phase: "rotate" } }),
						context,
					);
					return;
				}
				const submission = await conv.submit(
					{
						type: "input",
						content: checkpointPrompt,
						requestId: key(task.id),
						whenBusy: "followUp",
					},
					context,
				);
				await runtime.commit(
					() => ({
						status: "running",
						checkpoint: { phase: "checkpoint", submission: submission.id },
					}),
					context,
				);
			},
			checkpoint: async (task, runtime, context) => {
				const submission = await host().harness.submission(
					task.state.checkpoint.submission,
					context,
				);
				if (!submission)
					throw new Error("Context checkpoint submission is missing");
				const result = await submission.wait(context);
				await runtime.commit(async (tx) => {
					const fresh = await notesAreFresh(tx, task.conversationId);
					if (result.status === "done" && fresh)
						return { status: "running", checkpoint: { phase: "rotate" } };
					const state = await tx.doc(WindowState, task.conversationId);
					if (result.status === "unanswered" && result.reason === "aborted")
						await cancelHeldInputs(tx, task.conversationId);
					if (state.transition === task.id) delete state.transition;
					return {
						status: "terminal",
						outcome: {
							status: "completed",
							result:
								result.status === "unanswered" && result.reason === "aborted"
									? { status: "cancelled" }
									: {
											status: "failed",
											reason:
												result.status === "done"
													? "Checkpoint finished without saving fresh notes"
													: `Checkpoint was unanswered: ${result.reason}`,
										},
						},
					};
				}, context);
			},
			rotate: async (task, runtime, context) => {
				const conv = await conversation(host(), task.conversationId, context);
				for (;;) {
					const tasks = await conv.commit(
						(tx) => foreignTasks(tx, conv.id),
						context,
					);
					if (!tasks.length) break;
					await Promise.all(
						tasks.map((id) => runtime.waitForTask(id, context)),
					);
				}
				await runtime.commit(async (tx) => {
					const idle = await nativeIdle(tx, task.conversationId);
					const tasks = await foreignTasks(tx, task.conversationId);
					const fresh = await notesAreFresh(tx, task.conversationId);
					const state = await tx.doc(WindowState, task.conversationId);
					if (!state.window || state.transition !== task.id)
						throw new Error("Context rollover lost its window claim");
					if (!idle || tasks.length || !fresh) {
						delete state.transition;
						return {
							status: "terminal",
							outcome: {
								status: "completed",
								result: {
									status: "failed",
									reason:
										"Conversation changed before context rollover; retry after it settles",
								},
							},
						};
					}
					const window = {
						id: task.input.windowId,
						number: state.window.number + 1,
						startedAt: runtime.now(),
						previous: state.window.id,
					};
					// The idle check, head cut and logical identity share one transaction. Old entries remain stored.
					const entry = await tx.appendEntry(WindowEntry, task.conversationId, {
						data: window,
						head: "self",
					});
					state.window = window;
					state.entry = entry.id;
					state.reminded = 0;
					delete state.settlement;
					if (task.input.continue)
						return {
							status: "running",
							checkpoint: { phase: "continue", window },
						};
					delete state.transition;
					return {
						status: "terminal",
						outcome: {
							status: "completed",
							result: { status: "done", window },
						},
					};
				}, context);
			},
			continue: async (task, runtime, context) => {
				const conv = await conversation(host(), task.conversationId, context);
				const submission = await conv.submit(
					{
						type: "input",
						content: "Continue from your saved notes.",
						requestId: `context:continue:${task.id}`,
						whenBusy: "followUp",
					},
					context,
				);
				await runtime.commit(async (tx) => {
					const state = await tx.doc(WindowState, task.conversationId);
					if (state.transition === task.id) delete state.transition;
					return {
						status: "terminal",
						outcome: {
							status: "completed",
							result: {
								status: "done",
								window: task.state.checkpoint.window,
								continuation: submission.id,
							},
						},
					};
				}, context);
			},
		},
		abort: async (task, runtime, context) => {
			await cancelInput(host(), task.conversationId, key(task.id), context);
			await cancelInput(
				host(),
				task.conversationId,
				`context:continue:${task.id}`,
				context,
			);
			await runtime.commit(async (tx) => {
				const state = await tx.doc(WindowState, task.conversationId);
				if (state.transition === task.id) {
					await cancelHeldInputs(tx, task.conversationId);
					delete state.transition;
				}
				return { status: "terminal", outcome: { status: "aborted" } };
			}, context);
		},
	});
}

export async function scheduleRollover(
	tx: Tx,
	id: ConversationId,
	task: ReturnType<typeof createRollover>,
	reason: RolloverInput["reason"],
	owner?: TaskId,
): Promise<TaskId<TransitionResult>> {
	const state = await tx.doc(WindowState, id);
	if (!state.window) throw new Error("Context window has not been initialized");
	if (state.transition) return state.transition;
	const next = await tx.createTask(
		task,
		{ reason, continue: reason === "tool", windowId: crypto.randomUUID() },
		{
			ownership:
				owner === undefined
					? { kind: "conversation" }
					: { kind: "task", taskId: owner },
			conversationId: id,
		},
	);
	state.transition = next;
	return next;
}

export async function transitionResult(
	host: ContextHost,
	id: TaskId<TransitionResult>,
	context: Context,
): Promise<TransitionResult> {
	const task = await host.harness.waitForTask(id, context);
	return task.state.outcome.status === "completed"
		? task.state.outcome.result
		: task.state.outcome.status === "aborted"
			? { status: "cancelled" }
			: {
					status: "failed",
					reason: `Context rollover ${task.state.outcome.status}`,
				};
}
