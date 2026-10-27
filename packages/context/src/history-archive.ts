import type { Context } from "@earendil-works/chord";
import {
	CompactionEntry,
	type Conversation,
	type ConversationId,
	type ConversationRecord,
	type Cursor,
	type EntryId,
	type EntryRecord,
	type Storage,
	UserEntry,
} from "@earendil-works/pi-durable";
import { canReadContextTarget } from "../../../internal/context-visibility.ts";
import { WindowEntry } from "./window-state.ts";

export type HistoryEntry = {
	windowId: string;
	entry: EntryRecord;
	boundary: boolean;
	summary: boolean;
};
export type HistoryReader = (
	id: ConversationId,
	context: Context,
) => Promise<Conversation>;

/** References only. The transcript remains solely in Durable's retained fork history. */
async function* retainedBranches(
	storage: Storage,
	caller: ConversationId,
	target: ConversationId,
	context: Context,
	familyTargets: readonly ConversationId[] | undefined,
) {
	const ancestry = async (id: ConversationId) => {
		const chain: ConversationRecord[] = [];
		const seen = new Set<ConversationId>();
		for (;;) {
			context.abortSignal?.throwIfAborted();
			if (seen.has(id))
				throw new Error("Retained conversation ancestry contains a cycle");
			seen.add(id);
			const record = await storage.conversation(id, context);
			if (!record)
				throw new Error("Retained conversation ancestry is unavailable");
			chain.push(record);
			if (!record.parent) return chain;
			id = record.parent.conversationId;
		}
	};
	const current = await ancestry(target);
	const root = current.at(-1)?.id;
	// Current history already includes these prefixes. Additional readers contribute only their own later entries.
	const inherited = new Map<ConversationId, EntryId>();
	let cutoff: EntryId | undefined;
	for (const record of current) {
		if (cutoff !== undefined) inherited.set(record.id, cutoff);
		if (record.parent)
			cutoff =
				cutoff === undefined || record.parent.at < cutoff
					? record.parent.at
					: cutoff;
	}
	let cursor: Cursor | undefined;
	do {
		context.abortSignal?.throwIfAborted();
		const page = await storage.scanConversations(
			{ order: "descending" },
			64,
			cursor,
			context,
		);
		for (const record of page.items) {
			context.abortSignal?.throwIfAborted();
			if (
				record.id === target ||
				(familyTargets && !familyTargets.includes(record.id)) ||
				(await ancestry(record.id)).at(-1)?.id !== root
			)
				continue;
			if (
				!(await canReadContextTarget(storage, caller, record.id, context)) ||
				!(await canReadContextTarget(storage, target, record.id, context))
			)
				continue;
			const after = inherited.get(record.id);
			yield { id: record.id, ...(after === undefined ? {} : { after }) };
		}
		cursor = page.next;
	} while (cursor !== undefined);
}

/** Paged catalogue and transcript reads. Only the current ancestry stays in memory. */
export async function* historyEntries(options: {
	conversation: Conversation;
	activeWindow: string;
	caller: ConversationId;
	storage: Storage;
	reader: HistoryReader;
	activeWindowFor: (id: ConversationId) => Promise<string>;
	archive: boolean;
	familyTargets?: readonly ConversationId[] | undefined;
	windowId?: string | null | undefined;
	context: Context;
}): AsyncGenerator<HistoryEntry> {
	const { context, conversation, archive } = options;
	const branches = archive
		? retainedBranches(
				options.storage,
				options.caller,
				conversation.id,
				context,
				options.familyTargets,
			)
		: [];
	async function* readers(): AsyncGenerator<{
		id: ConversationId;
		after?: EntryId;
	}> {
		yield { id: conversation.id };
		yield* branches;
	}
	for await (const branch of readers()) {
		const extra = branch.id !== conversation.id;
		if (
			options.windowId &&
			(extra
				? !options.windowId.startsWith(`archive:${branch.id}:`)
				: options.windowId.startsWith("archive:"))
		)
			continue;
		const reader = extra
			? await options.reader(branch.id, context)
			: conversation;
		if (reader.id !== branch.id)
			throw new Error("Archive reader is bound to a different conversation");
		let windowId = extra
			? await options.activeWindowFor(branch.id)
			: options.activeWindow;
		let cursor: Cursor | undefined;
		do {
			context.abortSignal?.throwIfAborted();
			const page = await reader.entries({}, 64, cursor, context);
			for (const entry of page.items) {
				context.abortSignal?.throwIfAborted();
				const boundary = WindowEntry.is(entry);
				if (
					archive &&
					boundary &&
					(!entry.data ||
						typeof entry.data.id !== "string" ||
						!entry.data.id ||
						(entry.data.previous !== undefined &&
							(typeof entry.data.previous !== "string" ||
								!entry.data.previous ||
								entry.data.previous === entry.data.id)))
				)
					throw new Error("Retained window has an invalid archive reference");
				if (boundary) windowId = entry.data.id;
				if (
					!extra ||
					(entry.conversationId === branch.id &&
						(!("after" in branch) ||
							branch.after === undefined ||
							entry.id > branch.after))
				) {
					const summary = archive && CompactionEntry.is(entry);
					if (summary) {
						if (
							entry.head === undefined ||
							entry.head >= entry.id ||
							!(
								await reader.entries(
									{ minEntryId: entry.head, maxEntryId: entry.head },
									1,
									undefined,
									context,
								)
							).items.some((item) => item.id === entry.head)
						)
							throw new Error(
								"Retained summary references an unavailable archive boundary",
							);
					}
					yield {
						windowId: extra
							? `archive:${branch.id}:${encodeURIComponent(windowId)}`
							: windowId,
						entry,
						boundary,
						summary,
					};
				}
				if (boundary) windowId = entry.data.previous ?? entry.data.id;
			}
			cursor = page.next;
		} while (cursor !== undefined);
	}
}

/** Opaque recovery references only, never summary or transcript contents in the prompt. */
export async function renderArchiveHistoryHint(
	conversation: Conversation,
	activeWindow: string,
	context: Context,
): Promise<string> {
	const users: { window_id: string; item_id: string }[] = [];
	let summary: { window_id: string; item_id: string } | undefined;
	let windowId = activeWindow;
	let cursor: Cursor | undefined;
	do {
		context.abortSignal?.throwIfAborted();
		const page = await conversation.entries({}, 64, cursor, context);
		for (const entry of page.items) {
			context.abortSignal?.throwIfAborted();
			if (WindowEntry.is(entry)) {
				windowId = entry.data.previous ?? entry.data.id;
				continue;
			}
			const reference = { window_id: windowId, item_id: String(entry.id) };
			if (!summary && CompactionEntry.is(entry)) {
				if (
					entry.head === undefined ||
					entry.head >= entry.id ||
					!(
						await conversation.entries(
							{ minEntryId: entry.head, maxEntryId: entry.head },
							1,
							undefined,
							context,
						)
					).items.some((item) => item.id === entry.head)
				)
					throw new Error(
						"Retained summary references an unavailable archive boundary",
					);
				summary = reference;
			}
			if (users.length < 3 && UserEntry.is(entry)) users.push(reference);
			if (summary && users.length === 3) break;
		}
		cursor = page.next;
	} while (cursor !== undefined && !(summary && users.length === 3));
	if (!summary && users.length === 0) return "";
	return `History recovery IDs: ${JSON.stringify({ ...(summary ? { summary } : {}), recent_user_requests: users })}. Read known items directly or search for missing details; do not enumerate the archive.`;
}
