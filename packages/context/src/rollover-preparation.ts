import type { Context } from "@earendil-works/chord";
import {
	type Conversation,
	type ConversationId,
	defineDoc,
	type EntryId,
	type TaskId,
	type Tx,
} from "@earendil-works/pi-durable";

export type BeforeRollover = (
	request: {
		conversationId: ConversationId;
		windowId: string;
		nextWindowId: string;
		reason: "idle" | "manual" | "tool";
	},
	context: Context,
) => Promise<void>;

type Preparation = {
	head?: EntryId | null;
	error?: string;
};
const RolloverPreparation = defineDoc<{
	state?:
		| { status: "started"; head: EntryId | null }
		| { status: "done"; head: EntryId | null }
		| { status: "failed"; error: string };
}>({
	kind: "howaboua.context.rollover-preparation",
	version: 1,
	scope: "task",
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
	initial: () => ({}),
});

export async function latestContextEntry(
	tx: Tx,
	id: ConversationId,
): Promise<EntryId | null> {
	let cursor;
	do {
		const page = await tx.scanEntries({ conversationId: id }, 64, cursor);
		// Refreshes may record passive receipts without changing model context.
		const entry = page.items.find(
			(item) =>
				item.model?.length || item.head !== undefined || item.edits?.length,
		);
		if (entry) return entry.id;
		cursor = page.next;
	} while (cursor !== undefined);
	return null;
}

/** Await host effects before retiring history, but never replay an uncertain effect. */
export async function prepareRollover(
	conversation: Conversation,
	taskId: TaskId,
	callback: BeforeRollover | undefined,
	request: Parameters<BeforeRollover>[0],
	ready: (tx: Tx) => Promise<boolean>,
	context: Context,
): Promise<Preparation> {
	if (!callback) return {};
	const admission = await conversation.commit<Preparation & { execute?: true }>(
		async (tx) => {
			if (!(await ready(tx)))
				return {
					error:
						"Conversation changed before context rollover; save fresh notes and retry after it settles",
				};
			const receipt = await tx.doc(RolloverPreparation, taskId);
			if (receipt.state?.status === "done") return { head: receipt.state.head };
			if (receipt.state?.status === "failed")
				return { error: receipt.state.error };
			if (receipt.state?.status === "started")
				return {
					error:
						"Context rollover preparation was interrupted; its outcome is uncertain. The window is unchanged. Check the connected service before requesting another rollover",
				};
			const head = await latestContextEntry(tx, conversation.id);
			receipt.state = { status: "started", head };
			return { head, execute: true };
		},
		context,
	);
	if (!admission.execute || admission.head === undefined) return admission;
	const head = admission.head;
	try {
		await callback(request, context);
		context.abortSignal?.throwIfAborted();
	} catch (error) {
		context.abortSignal?.throwIfAborted();
		const reason = `Context rollover preparation failed: ${error instanceof Error ? error.message : String(error)}. The window is unchanged`;
		await conversation.commit(async (tx) => {
			(await tx.doc(RolloverPreparation, taskId)).state = {
				status: "failed",
				error: reason,
			};
		}, context);
		return { error: reason };
	}
	await conversation.commit(async (tx) => {
		(await tx.doc(RolloverPreparation, taskId)).state = {
			status: "done",
			head,
		};
	}, context);
	return { head };
}
