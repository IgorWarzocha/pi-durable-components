// Adapted from pi-codex-conversion, Copyright (c) 2026 Igor Warzocha, MIT.
import type { Context } from "@earendil-works/chord";
import type {
	Conversation,
	ConversationId,
	Cursor,
	EntryRecord,
	JsonObject,
} from "@earendil-works/pi-durable";
import { defineTool } from "@earendil-works/pi-durable";
import {
	boundedPreviews,
	historyItem,
	itemIdentity,
	matchesHistoryItem,
	previewHistoryItem,
} from "./history-items.ts";
import {
	boundedInteger,
	type HistoryArguments,
	historyParameters,
	validateHistoryArguments,
} from "./tool-contract.ts";
import { WindowEntry, WindowState } from "./window-state.ts";

export function createHistoryTool(options: {
	conversation: (id: ConversationId, context: Context) => Promise<Conversation>;
}) {
	return defineTool({
		name: "history",
		description:
			"Prior-window detail. Pass IDs unchanged. Search, never browse.",
		parameters: historyParameters,
		replay: "safe",
		async execute(args, api, context) {
			validateHistoryArguments(args);
			context.abortSignal?.throwIfAborted();
			const state = await api.snapshot(
				WindowState,
				api.conversationId,
				context,
			);
			if (!state?.window)
				throw new Error(
					"Context window is missing; ask the host to run context.bind or context.submit before using context tools",
				);
			const conversation = await options.conversation(
				api.conversationId,
				context,
			);
			if (conversation.id !== api.conversationId)
				throw new Error("History reader is bound to a different conversation");
			const result = await readHistory(
				conversation,
				state.window.id,
				args,
				context,
			);
			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
				details: result,
			};
		},
	});
}

/** Newest-first pages include retired context. Initialization identifies, but never cuts, earlier input. */
async function* windowEntries(
	conversation: Conversation,
	activeWindow: string,
	context: Context,
): AsyncGenerator<{ windowId: string; entry: EntryRecord; boundary: boolean }> {
	let cursor: Cursor | undefined;
	let windowId = activeWindow;
	do {
		context.abortSignal?.throwIfAborted();
		const page = await conversation.entries({}, 64, cursor, context);
		for (const entry of page.items) {
			if (WindowEntry.is(entry)) {
				yield { windowId: entry.data.id, entry, boundary: true };
				if (entry.data.previous) windowId = entry.data.previous;
				else windowId = entry.data.id;
			} else yield { windowId, entry, boundary: false };
		}
		cursor = page.next;
	} while (cursor !== undefined);
}

async function readHistory(
	conversation: Conversation,
	activeWindow: string,
	args: HistoryArguments,
	context: Context,
): Promise<JsonObject> {
	if (args.action === "list_windows") {
		const limit = boundedInteger(args.limit, 20, 100, 0);
		if (limit === 0) return { source: "sqlite", windows: [] };
		const counts = new Map<string, number>([[activeWindow, 0]]);
		for await (const { entry, windowId, boundary } of windowEntries(
			conversation,
			activeWindow,
			context,
		)) {
			if (!counts.has(windowId)) {
				if (counts.size >= limit && args.recent_first) break;
				counts.set(windowId, 0);
				if (counts.size > limit) {
					const newest = counts.keys().next().value;
					if (newest !== undefined) counts.delete(newest);
				}
			}
			if (!boundary && entry.model?.length)
				counts.set(windowId, (counts.get(windowId) ?? 0) + 1);
		}
		const windows = [...counts].map(([window_id, item_count]) => ({
			window_id,
			item_count,
		}));
		if (!args.recent_first) windows.reverse();
		return { source: "sqlite", windows };
	}
	if (args.action === "read_item")
		return readItem(conversation, activeWindow, args, context);
	const limit = boundedInteger(args.limit, 10, 25, 0);
	const maxChars = boundedInteger(args.max_chars_per_item, 1_000, 1_000, 0);
	const items: JsonObject[] = [];
	if (limit > 0)
		for await (const { entry, windowId, boundary } of windowEntries(
			conversation,
			activeWindow,
			context,
		)) {
			if (boundary || (args.window_id && windowId !== args.window_id)) continue;
			const item = historyItem(entry, windowId);
			if (!item || !matchesHistoryItem(item, args)) continue;
			items.push(previewHistoryItem(item, maxChars));
			if (items.length >= limit && args.recent_first) break;
			// Oldest-first needs a full scan, but retains only the bounded result set.
			if (items.length > limit) items.shift();
		}
	if (!args.recent_first) items.reverse();
	return { source: "sqlite", items: boundedPreviews(items) };
}

async function readItem(
	conversation: Conversation,
	activeWindow: string,
	args: HistoryArguments,
	context: Context,
): Promise<JsonObject> {
	let candidate: EntryRecord | undefined;
	for await (const { entry, windowId, boundary } of windowEntries(
		conversation,
		activeWindow,
		context,
	)) {
		if (boundary || windowId !== args.window_id) continue;
		const id = String(entry.id);
		if (id !== args.item_id && !id.endsWith(args.item_id ?? "")) continue;
		if (entry.model?.length) candidate = entry;
	}
	// Source suffix matching chooses the earliest matching item in the window.
	const item = candidate
		? historyItem(candidate, args.window_id ?? "")
		: undefined;
	if (!item) return { source: "sqlite", item: null };
	const offset = boundedInteger(args.offset_chars, 0, item.content.length, 0);
	const limit = boundedInteger(args.limit_chars, 8_000, 8_000, 0);
	const content = item.content.slice(offset, offset + limit);
	const nextOffset = offset + content.length;
	return {
		source: "sqlite",
		item: {
			...itemIdentity(item),
			content,
			total_chars: item.content.length,
			...(nextOffset < item.content.length
				? { next_offset_chars: nextOffset }
				: {}),
		},
	};
}
