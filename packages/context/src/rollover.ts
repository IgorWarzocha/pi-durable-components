import type { Context } from "@earendil-works/chord";
import type {
	ConversationId,
	Cursor,
	SubmissionId,
	TaskId,
	Tx,
} from "@earendil-works/pi-durable";
import { defineTask, LiveDoc } from "@earendil-works/pi-durable";
import {
	instructionAnswer,
	instructionOutcome,
	startInstruction,
	waitInstruction,
} from "./instruction-run.ts";
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
	| { phase: "instruction"; generation: TaskId }
	| { phase: "rotate" }
	| { phase: "continue"; window: WindowIdentity }
	| { phase: "continued"; window: WindowIdentity; generation: TaskId };

const checkpointPrompt =
	"Save the task state in notes, then finish your reply. A new window opens automatically after your reply; do not call new_context. If saving fails, report the error.";
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
				if (task.input.reason === "idle") {
					await runtime.commit(async (tx) => {
						const state = await tx.doc(WindowState, conv.id);
						if (state.transition === task.id) delete state.transition;
						return {
							status: "terminal",
							outcome: {
								status: "completed",
								result: {
									status: "skipped",
									reason: "Latest completed run has no fresh notes",
								},
							},
						};
					}, context);
					return;
				}
				await runtime.commit(async (tx) => {
					const generation = await startInstruction(
						tx,
						conv.id,
						task.id,
						"howaboua.context.checkpoint",
						checkpointPrompt,
						runtime.now(),
					);
					if (!generation)
						return { status: "running", checkpoint: { phase: "prepare" } };
					return {
						status: "running",
						checkpoint: { phase: "instruction", generation },
					};
				}, context);
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
			instruction: async (task, runtime, context) => {
				await waitInstruction(
					host(),
					task.conversationId,
					task.state.checkpoint.generation,
					context,
				);
				await runtime.commit(async (tx) => {
					const outcome = await instructionOutcome(
						tx,
						task.conversationId,
						task.state.checkpoint.generation,
					);
					if (!outcome) return;
					const aborted = outcome === "aborted";
					const fresh = await notesAreFresh(tx, task.conversationId);
					if (
						outcome === "completed" &&
						fresh &&
						(await instructionAnswer(tx, task.conversationId))
					)
						return { status: "running", checkpoint: { phase: "rotate" } };
					const state = await tx.doc(WindowState, task.conversationId);
					if (aborted) await cancelHeldInputs(tx, task.conversationId);
					if (state.transition === task.id) delete state.transition;
					return {
						status: "terminal",
						outcome: {
							status: "completed",
							result: aborted
								? { status: "cancelled" }
								: {
										status: "failed",
										reason: "Checkpoint finished without saving fresh notes",
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
					const completed =
						task.input.reason !== "idle" ||
						(state.settlement?.completed === true &&
							state.settlement.userEntry ===
								(await latestUserEntry(tx, task.conversationId)));
					if (!state.window || state.transition !== task.id)
						throw new Error("Context rollover lost its window claim");
					if (!idle || tasks.length || !fresh || !completed) {
						delete state.transition;
						return {
							status: "terminal",
							outcome: {
								status: "completed",
								result: {
									status: task.input.reason === "idle" ? "skipped" : "failed",
									reason:
										task.input.reason === "idle"
											? "Conversation changed before automatic context rollover"
											: "Conversation changed before context rollover; retry after it settles",
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
				// Recover legacy tool-transition receipts without manufacturing a user input.
				await runtime.commit(async (tx) => {
					const generation = await startInstruction(
						tx,
						task.conversationId,
						task.id,
						"howaboua.context.continuation",
						"Read your saved notes and resume the task.",
						runtime.now(),
					);
					if (!generation)
						throw new Error("Conversation changed before legacy continuation");
					return {
						status: "running",
						checkpoint: {
							phase: "continued",
							window: task.state.checkpoint.window,
							generation,
						},
					};
				}, context);
			},
			continued: async (task, runtime, context) => {
				await waitInstruction(
					host(),
					task.conversationId,
					task.state.checkpoint.generation,
					context,
				);
				await runtime.commit(async (tx) => {
					const outcome = await instructionOutcome(
						tx,
						task.conversationId,
						task.state.checkpoint.generation,
					);
					if (!outcome) return;
					const state = await tx.doc(WindowState, task.conversationId);
					if (state.transition === task.id) delete state.transition;
					const answer = await instructionAnswer(tx, task.conversationId);
					return {
						status: "terminal",
						outcome: {
							status: "completed",
							result:
								outcome === "completed" && answer !== undefined
									? {
											status: "done",
											window: task.state.checkpoint.window,
											answer,
										}
									: {
											status: "failed",
											reason:
												"Context continuation did not finish successfully",
										},
						},
					};
				}, context);
			},
		},
		abort: async (task, runtime, context) => {
			if (
				task.state.checkpoint.phase === "instruction" ||
				task.state.checkpoint.phase === "continued"
			) {
				const live = await runtime.snapshot(
					LiveDoc,
					task.conversationId,
					context,
				);
				if (live?.run && live.run.inputs.length === 0) {
					await host().harness.abortTask(live.run.taskId, context);
					await host().harness.waitForTask(live.run.taskId, context);
				}
			}
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
