// Adapted from pi-codex-conversion, Copyright (c) 2026 Igor Warzocha, MIT.
import type { Context } from "@earendil-works/chord";

import {
	CompactionEntry,
	type Conversation,
	type ConversationId,
	type Cursor,
	defineTool,
	type EntryId,
	type EntryRecord,
	type JsonObject,
	type Storage,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { canReadContextTarget } from "../../../internal/context-visibility.ts";
import { type HistoryEntry, historyEntries } from "./history-archive.ts";
import {
	boundedPreviews,
	historyItem,
	itemIdentity,
	matchesHistoryItem,
	previewHistoryItem,
	rankedHistoryText,
} from "./history-items.ts";
import type { HistoryRanker, RankedHistory } from "./history-ranker.ts";
import {
	type ContextRemoteCatalog,
	remoteContextHelp,
	resolveContextTarget,
} from "./remote.ts";
import {
	boundedInteger,
	contextHelpText,
	contextOutputLimits,
	contextTextSlice,
	contextToolHelp,
	contextToolResult,
	type HistoryArguments,
	historyParameters,
	prepareHistoryArguments,
	validateHistoryArguments,
} from "./tool-contract.ts";
import { WindowEntry, WindowState } from "./window-state.ts";

const refreshFailures = new WeakMap<HistoryRanker, Map<string, Error>>();

export function createHistoryTool(options: {
	conversation: (id: ConversationId, context: Context) => Promise<Conversation>;
	storage: () => Storage;
	remote?: ContextRemoteCatalog | undefined;
	archiveHistory?: boolean;
	rankedHistory?: RankedHistory | undefined;
}) {
	const tool = defineTool({
		name: "history",
		description: "Search earlier conversation",
		parameters: historyParameters,
		structuredOutputSchema: Type.Object({}, { additionalProperties: true }),
		prepareArguments: prepareHistoryArguments,
		replay: "safe",
		outputLimits: contextOutputLimits,
		async execute(args = {}, api, context) {
			const rankedEnabled =
				options.rankedHistory !== undefined &&
				(options.rankedHistory.enabled?.(api.conversationId) ?? true);
			let help = contextToolHelp("history", args, rankedEnabled);
			if (help)
				help = {
					...help,
					...(await remoteContextHelp(
						options.remote,
						api.conversationId,
						options.storage(),
						context,
					)),
				};
			if (help) {
				contextHelpText(help);
				return contextToolResult(help);
			}
			validateHistoryArguments(args);
			context.abortSignal?.throwIfAborted();
			const { target, familyTargets } = await resolveContextTarget(
				options.remote,
				args,
				api.conversationId,
				context,
			);
			if (
				target !== api.conversationId &&
				!(await canReadContextTarget(
					options.storage(),
					api.conversationId,
					target,
					context,
				))
			)
				throw new Error("This conversation's context is not visible here");
			const conversation = await options.conversation(target, context);
			if (conversation.id !== target)
				throw new Error("History reader is bound to a different conversation");
			let scanned = 0;
			const charge = (count: number) => {
				if (options.archiveHistory && (scanned += count) > 50_000)
					throw new Error(
						"Archive scan exceeds 50000 entries; use an exact window or narrower target",
					);
			};
			const activeWindowFor = async (id: ConversationId) => {
				const state = await api.snapshot(WindowState, id, context);
				if (state?.window) return state.window.id;
				if (options.archiveHistory) {
					const reader =
						id === target
							? conversation
							: await options.conversation(id, context);
					let cursor: Cursor | undefined;
					do {
						context.abortSignal?.throwIfAborted();
						const page = await reader.entries({}, 64, cursor, context);
						charge(page.items.length);
						const boundary = page.items.find((entry) => WindowEntry.is(entry));
						if (boundary && WindowEntry.is(boundary)) return boundary.data.id;
						cursor = page.next;
					} while (cursor !== undefined);
				}
				return `conversation:${id}`;
			};
			const activeWindow = await activeWindowFor(target);
			const activeIds = rankedEnabled
				? new Set(
						(await conversation.context(context)).entries.map(
							(entry) => entry.id,
						),
					)
				: new Set<EntryId>();
			const result = await readHistory(
				() =>
					historyEntries({
						conversation,
						activeWindow,
						caller: api.conversationId,
						storage: options.storage(),
						reader: options.conversation,
						activeWindowFor,
						familyTargets,
						windowId: args.window_id,
						charge,
						archive: options.archiveHistory === true,
						context,
					}),
				activeWindow,
				args,
				options.archiveHistory === true,
				rankedEnabled && target === api.conversationId && !args.agent_name
					? options.rankedHistory
					: undefined,
				context.abortSignal,
				activeIds,
				String(target),
			);
			return contextToolResult(result);
		},
	});
	return { ...tool, executionHints: { discovery: "help" as const } };
}

async function readHistory(
	entries: () => AsyncGenerator<HistoryEntry>,
	activeWindow: string,
	args: HistoryArguments,
	archive: boolean,
	ranked?: RankedHistory,
	signal?: AbortSignal,
	activeIds = new Set<EntryId>(),
	scope = "",
): Promise<JsonObject> {
	if (args.action === "list_windows") {
		const limit = boundedInteger(args.limit, 20, 100, 0);
		if (limit === 0) return { windows: [], truncated: true };
		const counts = new Map<string, number>([[activeWindow, 0]]);
		const newest = new Map<string, EntryId>();
		for await (const { entry, windowId, boundary } of entries()) {
			if (
				archive &&
				(!newest.has(windowId) || entry.id > (newest.get(windowId) ?? 0))
			)
				newest.set(windowId, entry.id);
			if (!counts.has(windowId)) {
				counts.set(windowId, 0);
				if (!archive && counts.size > limit && args.recent_first) break;
				if (!archive && counts.size > limit + 1) {
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
		if (archive)
			windows.sort(
				(left, right) =>
					((newest.get(left.window_id) ?? 0) -
						(newest.get(right.window_id) ?? 0)) *
					(args.recent_first ? -1 : 1),
			);
		else if (!args.recent_first) windows.reverse();
		return {
			windows: windows.slice(0, limit),
			truncated: windows.length > limit,
		};
	}
	if (args.action === "read_item") return readItem(entries, args);
	if (
		args.action === "search_contents" &&
		ranked &&
		(!args.role || args.role === "user" || args.role === "assistant") &&
		!args.tool_name &&
		!args.tool_namespace &&
		args.window_id !== activeWindow &&
		!args.window_id?.startsWith("archive:")
	) {
		return readRankedHistory(entries, args, ranked, activeIds, scope, signal);
	}
	const limit = boundedInteger(args.limit, 10, 25, 0);
	const maxChars = boundedInteger(args.max_chars_per_item, 1_000, 1_000, 0);
	const items: { id: EntryId; preview: JsonObject }[] = [];
	const summaries: { id: EntryId; preview: JsonObject }[] = [];
	let matched = 0;
	for await (const { entry, windowId, boundary, summary } of entries()) {
		if (boundary || (args.window_id && windowId !== args.window_id)) continue;
		const item = historyItem(entry, windowId);
		if (item && summary) item.role = "assistant";
		if (!item || !matchesHistoryItem(item, args)) continue;
		matched++;
		const selected =
			archive && args.action === "search_contents" && summary
				? summaries
				: items;
		selected.push({
			id: entry.id,
			preview: previewHistoryItem(item, maxChars),
		});
		selected.sort(
			(left, right) => (left.id - right.id) * (args.recent_first ? -1 : 1),
		);
		if (items.length > limit && args.recent_first && !archive) break;
		// Oldest-first needs a full scan, but retains only the bounded result set.
		if (selected.length > limit) selected.pop();
	}
	const previews = boundedPreviews(
		[...summaries, ...items].slice(0, limit).map((item) => item.preview),
	);
	return {
		truncated: matched > previews.length,
		...(args.action === "search_contents" ? { search_mode: "literal" } : {}),
		items: previews,
	};
}

async function readItem(
	entries: () => AsyncGenerator<HistoryEntry>,
	args: HistoryArguments,
): Promise<JsonObject> {
	let candidate: EntryRecord | undefined;
	let candidateSummary = false;
	for await (const { entry, windowId, boundary, summary } of entries()) {
		if (boundary || windowId !== args.window_id) continue;
		const id = String(entry.id);
		if (id !== args.item_id) continue;
		if (entry.model?.length) {
			candidate = entry;
			candidateSummary = summary;
		}
	}
	// Canonical IDs are exact; suffix aliases can select the wrong retained entry.
	const item = candidate
		? historyItem(candidate, args.window_id ?? "")
		: undefined;
	if (!item) return { item: null };
	if (candidateSummary) item.role = "assistant";
	const offset = boundedInteger(args.offset_chars, 0, item.content.length, 0);
	const limit = boundedInteger(args.limit_chars, 8_000, 8_000, 0);
	const content = contextTextSlice(item.content, offset, limit);
	const nextOffset = offset + content.length;
	return {
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

async function readRankedHistory(
	entries: () => AsyncGenerator<HistoryEntry>,
	args: HistoryArguments,
	ranked: RankedHistory,
	activeIds: ReadonlySet<EntryId>,
	scope: string,
	signal?: AbortSignal,
): Promise<JsonObject> {
	signal?.throwIfAborted();
	const previousFailure = refreshFailures.get(ranked.ranker)?.get(scope);
	if (previousFailure) {
		refreshFailures.get(ranked.ranker)?.delete(scope);
		throw new Error(
			"Earlier history indexing failed. Retry this search or disable ranked history; list_items and read_item remain available.",
			{ cause: previousFailure },
		);
	}

	const canonical = new Map<
		string,
		NonNullable<ReturnType<typeof historyItem>>
	>();
	const index: { id: string; content: string }[] = [];
	let scanned = 0;
	for await (const { entry, windowId, boundary, summary } of entries()) {
		if (++scanned > 50_000)
			throw new Error(
				"Ranked history scan exceeds 50000 entries; use an exact window",
			);
		if (
			boundary ||
			summary ||
			(args.window_id && windowId !== args.window_id) ||
			activeIds.has(entry.id) ||
			windowId.startsWith("archive:")
		)
			continue;
		const item = historyItem(entry, windowId);
		if (!item || (args.role && item.role !== args.role)) continue;
		const content = rankedHistoryText(entry);
		if (!content) continue;
		canonical.set(item.item_id, item);
		index.push({ id: item.item_id, content });
	}
	// Durable pages are newest-first; the ranker's chronology is oldest-first.
	index.sort((a, b) => Number(a.id) - Number(b.id));
	const limit = boundedInteger(args.limit, 10, 25, 0);
	const ids = await ranked.ranker.search({
		scope,
		items: index,
		query: args.query ?? "",
		limit: limit + 1,
		recentFirst: args.recent_first === true,
		signal,
	});
	const maxChars = boundedInteger(args.max_chars_per_item, 1_000, 1_000, 0);
	const previews = boundedPreviews(
		ids.slice(0, limit).map((id) => {
			const item = canonical.get(id);
			if (!item)
				throw new Error("History ranker returned an out-of-scope item");
			return previewHistoryItem(item, maxChars);
		}),
	);
	return {
		items: previews,
		truncated: ids.length > previews.length,
		search_mode: "ranked_earlier_context",
	};
}

/** Awaited lifecycle refresh via public APIs. Optional index failures are reported
 * by the next ranked search, never by interrupting ordinary generation. Abort propagates. */
export async function refreshRankedHistory(
	conversation: Conversation,
	ranked: RankedHistory,
	context: Context,
): Promise<void> {
	if (!(ranked.enabled?.(conversation.id) ?? true)) return;
	try {
		const active = new Set(
			(await conversation.context(context)).entries.map((entry) => entry.id),
		);
		const items: { id: string; content: string }[] = [];
		let cursor: Cursor | undefined;
		let scanned = 0;
		do {
			context.abortSignal?.throwIfAborted();
			const page = await conversation.entries({}, 64, cursor, context);
			if ((scanned += page.items.length) > 50_000)
				throw new Error("Ranked history refresh exceeds 50000 entries");
			for (const entry of page.items) {
				if (active.has(entry.id) || CompactionEntry.is(entry)) continue;
				const content = rankedHistoryText(entry);
				if (content) items.push({ id: String(entry.id), content });
			}
			cursor = page.next;
		} while (cursor !== undefined);
		items.sort((a, b) => Number(a.id) - Number(b.id));
		await ranked.ranker.refresh({
			scope: String(conversation.id),
			items,
			signal: context.abortSignal,
		});
	} catch (error) {
		context.abortSignal?.throwIfAborted();
		let failures = refreshFailures.get(ranked.ranker);
		if (!failures) {
			failures = new Map();
			refreshFailures.set(ranked.ranker, failures);
		}
		failures.set(
			String(conversation.id),
			error instanceof Error
				? error
				: new Error("History indexing failed", { cause: error }),
		);
	}
}
