import type { Context } from "@earendil-works/chord";
import type {
	Conversation,
	ConversationId,
	Cursor,
	DocumentWatch,
	Harness,
	JsonObject,
	Storage,
	SubmissionId,
	SubmissionSettlement,
	TaskId,
	Tx,
} from "@earendil-works/pi-durable";
import {
	defineDoc,
	defineDocFamily,
	InboxDoc,
	LiveDoc,
} from "@earendil-works/pi-durable";
import {
	type TransitionResult,
	WindowEntry,
	type WindowIdentity,
	WindowState,
} from "./window-state.ts";

export const INPUT_TASK = "howaboua.context.input";
export const ROLLOVER_TASK = "howaboua.context.rollover";
export const IDLE_MS = 25 * 60 * 1000;
export type ContextHost = { harness: Harness; storage: Storage };
export type InputResult = SubmissionSettlement & { submission: SubmissionId };

export const Admission = defineDoc<{
	queue: TaskId[];
	cancelled: TaskId[];
	retry: number;
	blocked?: { task: TaskId; reason: string };
}>({
	kind: "howaboua.context.admission",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ queue: [], cancelled: [], retry: 0 }),
});
export const InputReceipt = defineDocFamily<
	{ task?: TaskId<InputResult> },
	null
>({
	kind: "howaboua.context.input-receipt",
	version: 1,
	scope: "conversation",
	family: true,
	history: "latest",
	fork: "initial",
	initial: () => ({}),
});
export const Continuation = defineDocFamily<
	{ task?: TaskId<TransitionResult> },
	null
>({
	kind: "howaboua.context.continuation",
	version: 1,
	scope: "conversation",
	family: true,
	history: "latest",
	fork: "initial",
	initial: () => ({}),
});

/** Cancellation must wake every held input before the rollover releases its claim. */
export async function cancelHeldInputs(
	tx: Tx,
	id: ConversationId,
): Promise<void> {
	const gate = await tx.doc(Admission, id);
	gate.cancelled = [...new Set([...gate.cancelled, ...gate.queue])];
}

export async function releaseAdmission(
	tx: Tx,
	id: ConversationId,
	task: TaskId,
): Promise<void> {
	const gate = await tx.doc(Admission, id);
	gate.queue = gate.queue.filter((item) => item !== task);
	gate.cancelled = gate.cancelled.filter((item) => item !== task);
	if (gate.blocked?.task === task) delete gate.blocked;
}

export async function conversation(
	host: ContextHost,
	id: ConversationId,
	context: Context,
): Promise<Conversation> {
	const value = await host.harness.conversation(id, context);
	if (!value) throw new Error(`Missing conversation ${id}`);
	return value;
}

export async function initializeWindow(
	tx: Tx,
	id: ConversationId,
	now: number,
): Promise<void> {
	const state = await tx.doc(WindowState, id);
	if (state.window) return;
	let previous: WindowIdentity | undefined;
	let cursor: Cursor | undefined;
	do {
		const page = await tx.scanEntries({ conversationId: id }, 64, cursor);
		const marker = page.items.find(WindowEntry.is);
		if (marker && WindowEntry.is(marker)) previous = marker.data;
		cursor = page.next;
	} while (!previous && cursor !== undefined);
	const window: WindowIdentity = {
		id: crypto.randomUUID(),
		number: (previous?.number ?? 0) + 1,
		startedAt: now,
		...(previous ? { previous: previous.id } : {}),
	};
	// Installation is not a history cut, even on a conversation that already has entries.
	// Fork initialization also preserves inherited window IDs used by saved note references.
	const entry = await tx.appendEntry(WindowEntry, id, { data: window });
	state.window = window;
	state.entry = entry.id;
}

/** Foreground cells also have to settle; waiting on the managed input itself would deadlock. */
export async function foreignTasks(
	tx: Tx,
	id: ConversationId,
): Promise<TaskId[]> {
	const tasks: TaskId[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await tx.scanTasks(
			{ conversationId: id, background: false },
			64,
			cursor,
		);
		for (const task of page.items) {
			if (
				task.state.status !== "terminal" &&
				task.kind !== INPUT_TASK &&
				task.kind !== ROLLOVER_TASK
			)
				tasks.push(task.id);
		}
		cursor = page.next;
	} while (cursor !== undefined);
	return tasks;
}

export async function nativeIdle(tx: Tx, id: ConversationId): Promise<boolean> {
	const live = await tx.doc(LiveDoc, id);
	const inbox = await tx.doc(InboxDoc, id);
	return !live.run && inbox.items.length === 0;
}

/** Own the watch through cancellation, including a change between acquisition and start. */
export async function until<T extends JsonObject>(
	watch: DocumentWatch<T> | undefined,
	predicate: (value: Readonly<T>) => boolean,
	signal: AbortSignal,
): Promise<void> {
	if (!watch) throw new Error("Context admission state is missing");
	let abort: () => void = () => {};
	try {
		await new Promise<void>((resolve, reject) => {
			abort = () => reject(signal.reason);
			signal.addEventListener("abort", abort, { once: true });
			watch.start(async (value) => {
				if (value && predicate(value)) resolve();
			});
			if (signal.aborted) abort();
			else if (watch.value && predicate(watch.value)) resolve();
			void watch.closed.then((end) => {
				if (end.reason !== "stopped")
					reject(new Error(`Context watch ended: ${end.reason}`));
			});
		});
	} finally {
		signal.removeEventListener("abort", abort);
		await watch.stop();
	}
}

/** Withdraw only the owned input. A placed input requires stopping its native generation. */
export async function cancelInput(
	host: ContextHost,
	id: ConversationId,
	requestId: string,
	context: Context,
): Promise<void> {
	const conv = await conversation(host, id, context);
	const input = await conv.commit(
		(tx) => tx.submissionByRequest(id, requestId),
		context,
	);
	if (!input || input.status === "done" || input.status === "unanswered")
		return;
	await host.harness.abortSubmission(input.id, context, id);
	await cancelPlacedInput(host, conv, input.id, context);
}

export async function cancelPlacedInput(
	host: ContextHost,
	conv: Conversation,
	id: SubmissionId,
	context: Context,
): Promise<void> {
	const run = await conv.commit(async (tx) => {
		const live = await tx.doc(LiveDoc, conv.id);
		return live.run?.inputs.includes(id) ? live.run.taskId : undefined;
	}, context);
	if (run) await host.harness.abortTask(run, context);
}
