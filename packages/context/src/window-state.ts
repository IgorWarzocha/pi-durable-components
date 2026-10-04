import type {
	ConversationId,
	EntryId,
	SubmissionId,
	TaskId,
	Tx,
} from "@earendil-works/pi-durable";
import { defineDoc, defineEntry } from "@earendil-works/pi-durable";

export type WindowIdentity = {
	id: string;
	number: number;
	startedAt: number;
	previous?: string;
};

export const WindowEntry = defineEntry<WindowIdentity>(
	"howaboua.context.window",
);

export type TransitionResult =
	| { status: "done"; window: WindowIdentity; continuation?: SubmissionId }
	| { status: "failed"; reason: string }
	| { status: "cancelled" };

export const WindowState = defineDoc<{
	window?: WindowIdentity;
	entry?: EntryId;
	settlement?: { observedAt: number; userEntry: EntryId | null };
	transition?: TaskId<TransitionResult>;
	reminded: number;
}>({
	kind: "howaboua.context.window-state",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "initial",
	initial: () => ({ reminded: 0 }),
});

/** A note is fresh only for the input visible when its original write committed. */
export async function latestUserEntry(
	tx: Tx,
	conversationId: ConversationId,
): Promise<EntryId | null> {
	let cursor;
	do {
		const page = await tx.scanEntries({ conversationId }, 64, cursor);
		const entry = page.items.find((item) => item.kind === "pi.user");
		if (entry) return entry.id;
		cursor = page.next;
	} while (cursor !== undefined);
	return null;
}
