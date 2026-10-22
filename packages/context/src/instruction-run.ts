import type { Context } from "@earendil-works/chord";
import {
	type ConversationId,
	GenerationTask,
	LiveDoc,
	type TaskId,
	type Tx,
} from "@earendil-works/pi-durable";
import { type ContextHost, nativeIdle } from "./lifecycle.ts";

/** Start trusted component instructions only, never user or peer content. */
export async function startInstruction(
	tx: Tx,
	id: ConversationId,
	owner: TaskId,
	kind: string,
	content: string,
	now: number,
) {
	if (!(await nativeIdle(tx, id))) return;
	await tx.appendEntry(id, {
		kind,
		model: [{ role: "system", content, timestamp: now }],
	});
	const generation = await tx.createTask(
		GenerationTask,
		{},
		{
			ownership: { kind: "task", taskId: owner },
			conversationId: id,
		},
	);
	// Public native run state: instructions need no invented user submission.
	(await tx.doc(LiveDoc, id)).run = { taskId: generation, inputs: [] };
	return generation;
}

export async function waitInstruction(
	host: ContextHost,
	id: ConversationId,
	generation: TaskId,
	context: Context,
) {
	for (;;) {
		await host.harness.waitForTask(generation, context);
		const live = await host.harness.snapshot(LiveDoc, id, context);
		if (!live?.run) return;
		generation = live.run.taskId;
	}
}

/** The native run can hand over and fail before its observer runs, including on reopen.
 * Task receipts, not the first generation or an earlier assistant entry, prove settlement.
 * Reject failures throughout the claimed interval, also when direct input bypassed admission.
 */
export async function instructionOutcome(
	tx: Tx,
	id: ConversationId,
	first: TaskId,
) {
	if ((await tx.doc(LiveDoc, id)).run) return;
	let cursor;
	let outcome: "completed" | "failed" | "aborted" = "completed";
	let found = false;
	do {
		const page = await tx.scanTasks(
			{
				conversationId: id,
				kind: GenerationTask.definition.name,
				order: "descending",
			},
			64,
			cursor,
		);
		for (const task of page.items) {
			if (task.id < first) return found ? outcome : undefined;
			found = true;
			if (task.state.status !== "terminal") return;
			if (task.state.outcome.status === "aborted") outcome = "aborted";
			else if (
				task.state.outcome.status !== "completed" &&
				outcome !== "aborted"
			)
				outcome = "failed";
		}
		cursor = page.next;
	} while (cursor !== undefined);
	return found ? outcome : undefined;
}

/** Recovery can find the first generation done but a successor failed or aborted. */
export async function instructionAnswer(tx: Tx, id: ConversationId) {
	let cursor;
	do {
		const page = await tx.scanEntries({ conversationId: id }, 64, cursor);
		for (const entry of page.items) {
			const final = entry.model?.findLast(
				(message) => message.role === "assistant",
			);
			if (final?.role === "assistant")
				return final.stopReason === "stop" || final.stopReason === "length"
					? entry.id
					: undefined;
			if (
				entry.kind === "howaboua.context.checkpoint" ||
				entry.kind === "howaboua.context.continuation"
			)
				return;
		}
		cursor = page.next;
	} while (cursor !== undefined);
}
