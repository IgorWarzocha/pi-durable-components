import type { Context } from "@earendil-works/chord";
import { withCancel } from "@earendil-works/chord/context";
import type {
	ConversationId,
	Cursor,
	Harness,
	Storage,
	SubmissionId,
	SubmissionRecord,
} from "@earendil-works/pi-durable";
import { defineTask, InboxDoc, LiveDoc } from "@earendil-works/pi-durable";
import type { WorkResult } from "./state.ts";
import { Fleet, submissionResult } from "./state.ts";
import { deliver } from "./tasks.ts";

/** The exact host Harness and storage passed to Harness.open. Neither is owned by this component. */
export type AgentsBinding = { harness: Harness; storage: Storage };
type Position = { after: number; pending: SubmissionId[] };
type WatchInput = Position & { target: ConversationId; key: string };
type WatchState =
	| ({ phase: "observe" } & Position)
	| ({ phase: "report"; result: WorkResult } & Position);
const completed = {
	status: "terminal",
	outcome: { status: "completed", result: null },
} as const;

/** Snapshot a subscription's starting boundary, retaining every already-admitted unsettled input. */
export async function watchBaseline(
	storage: Storage,
	target: ConversationId,
	context: Context,
): Promise<Position> {
	let after = 0;
	const pending: SubmissionId[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await storage.scanSubmissions(
			{ conversationId: target },
			100,
			cursor,
			context,
		);
		for (const input of page.items) {
			if (input.type !== "input") continue;
			after = Math.max(after, input.id);
			if (input.status === "queued" || input.status === "placed")
				pending.push(input.id);
		}
		cursor = page.next;
	} while (cursor !== undefined);
	return { after, pending };
}

async function nextInput(
	storage: Storage,
	target: ConversationId,
	position: Position,
	context: Context,
): Promise<SubmissionRecord | undefined> {
	const pending = position.pending[0];
	if (pending !== undefined) {
		const input = await storage.submission(pending, context);
		if (input === undefined || input.type !== "input")
			throw new Error(`Missing watched input ${pending}`);
		return input;
	}
	let cursor: Cursor | undefined;
	do {
		const page = await storage.scanSubmissions(
			{ conversationId: target },
			100,
			cursor,
			context,
		);
		const input = page.items.find(
			(item) => item.id > position.after && item.type === "input",
		);
		if (input !== undefined) return input;
		cursor = page.next;
	} while (cursor !== undefined);
	return undefined;
}

export function createWatch(binding: () => AgentsBinding) {
	return defineTask<WatchInput, WatchState, null>({
		name: "howaboua.agents.watch",
		version: 1,
		initial: (input) => ({
			phase: "observe",
			after: input.after,
			pending: [...input.pending],
		}),
		phases: {
			observe: async (task, runtime, context) => {
				const host = binding();
				// Acquire event sources before scanning. Inbox changes include queued inputs and withdrawals.
				const live = await runtime.watchDoc(
					LiveDoc,
					task.input.target,
					context,
				);
				const inbox = await runtime.watchDoc(
					InboxDoc,
					task.input.target,
					context,
				);
				const fleet = await runtime.watchDoc(Fleet, context);
				if (live === undefined || inbox === undefined || fleet === undefined)
					throw new Error("Agent watch documents are missing");
				let revision = 0;
				let wake: (() => void) | undefined;
				let withdraw: (() => void) | undefined;
				const withdrawn = new Promise<undefined>((resolve) => {
					withdraw = () => resolve(undefined);
				});
				const cancel = () => wake?.();
				const change = async () => {
					revision++;
					wake?.();
				};
				live.start(change);
				inbox.start(change);
				fleet.start(async (value) => {
					await change();
					if (value?.watches[task.input.key] !== task.id) withdraw?.();
				});
				runtime.signal.addEventListener("abort", cancel, { once: true });
				try {
					// Stay in this invocation on idle/unrelated wakes. Returning an unchanged checkpoint is not progress.
					while (true) {
						const seen = revision;
						const enabled =
							(await runtime.snapshot(Fleet, context))?.watches[
								task.input.key
							] === task.id;
						if (!enabled) {
							await runtime.commit(() => completed, context);
							return;
						}
						const input = await nextInput(
							host.storage,
							task.input.target,
							task.state.checkpoint,
							context,
						);
						if (input === undefined) {
							if (revision !== seen) continue;
							await new Promise<void>((resolve) => {
								wake = resolve;
								if (runtime.signal.aborted) resolve();
							});
							wake = undefined;
							runtime.signal.throwIfAborted();
							continue;
						}
						const submission = await host.harness.submission(input.id, context);
						if (submission === undefined)
							throw new Error(`Missing watched submission ${input.id}`);
						// Actual input settlement follows tool rounds, onYield continuations and terminal tool controls.
						const wait = withCancel(context);
						try {
							const settled = await Promise.race([
								submission.wait(wait.context),
								withdrawn,
							]);
							if (settled === undefined) {
								await runtime.commit(() => completed, context);
								return;
							}
							await runtime.commit(async (tx) => {
								if ((await tx.doc(Fleet)).watches[task.input.key] !== task.id)
									return completed;
								const result = await submissionResult(
									tx,
									task.input.target,
									settled,
								);
								const position = task.state.checkpoint;
								return {
									status: "running",
									checkpoint: {
										phase: "report",
										result,
										after: Math.max(position.after, input.id),
										pending: position.pending.filter((id) => id !== input.id),
									},
								};
							}, context);
							return;
						} finally {
							wait.cancel();
						}
					}
				} finally {
					runtime.signal.removeEventListener("abort", cancel);
					await Promise.all([live.stop(), inbox.stop(), fleet.stop()]);
				}
			},
			report: async (task, runtime, context) => {
				const state = task.state.checkpoint;
				const enabled =
					(await runtime.snapshot(Fleet, context))?.watches[task.input.key] ===
					task.id;
				if (enabled) await deliver(runtime, state.result, task.id, context);
				await runtime.commit(
					() =>
						enabled
							? {
									status: "running",
									checkpoint: {
										phase: "observe",
										after: state.after,
										pending: state.pending,
									},
								}
							: completed,
					context,
				);
			},
		},
		abort: (task, runtime, context) =>
			runtime.commit(async (tx) => {
				const fleet = await tx.doc(Fleet);
				if (fleet.watches[task.input.key] === task.id)
					delete fleet.watches[task.input.key];
				return { status: "terminal", outcome: { status: "aborted" } };
			}, context),
	});
}
