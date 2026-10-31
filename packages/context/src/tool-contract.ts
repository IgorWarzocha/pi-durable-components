// Adapted from pi-codex-conversion, Copyright (c) 2026 Igor Warzocha, MIT.

import type { ConversationId, JsonObject } from "@earendil-works/pi-durable";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { normalizeQueryInput } from "./query-input.ts";

const HISTORY_ACTIONS = [
	"help",
	"list_windows",
	"list",
	"read",
	"search",
] as const;
const NOTES_ACTIONS = [
	"help",
	"list",
	"read",
	"search",
	"append",
	"write",
] as const;

/** Source results are complete. Override Durable's configurable truncation defaults. */
export const contextOutputLimits = { maxBytes: Infinity, maxLines: Infinity };

/** Keep UTF-16 offsets without splitting a Unicode character across JSON/IPC pages. */
export function contextTextSlice(
	text: string,
	offset: number,
	limit: number,
): string {
	if (offset > 0 && (text.codePointAt(offset - 1) ?? 0) > 0xffff)
		throw new Error(
			"offset_chars splits a Unicode character; reduce it by one",
		);
	let end = offset + limit;
	if (limit > 0 && (text.codePointAt(end - 1) ?? 0) > 0xffff) end++;
	return text.slice(offset, end);
}

/** One bounded value for model text and programs; full read metadata stays host-side. */
export function contextToolResult(
	result: JsonObject,
	details: JsonObject = result,
) {
	const text = JSON.stringify(result);
	return {
		output: [{ type: "text" as const, text }],
		structuredOutput: result,
		details,
	};
}

const nullableString = Type.Union([Type.String(), Type.Null()]);
const positiveInteger = Type.Integer({ minimum: 1 });
const target = Type.Optional(
	Type.String({
		pattern: "^[1-9][0-9]*$",
		description: "Durable conversation ID; defaults to caller",
	}),
);

export const historyParameters = Type.Object(
	{
		action: Type.Optional(
			Type.Union(HISTORY_ACTIONS.map((action) => Type.Literal(action))),
		),
		target,
		item_id: Type.Optional(Type.String()),
		agent_name: Type.Optional(nullableString),
		limit: Type.Optional(positiveInteger),
		limit_chars: Type.Optional(positiveInteger),
		max_chars_per_item: Type.Optional(positiveInteger),
		offset_chars: Type.Optional(Type.Integer({ minimum: 0 })),
		query: Type.Optional(Type.String()),
		recent_first: Type.Optional(Type.Boolean()),
		role: Type.Optional(
			Type.Union([
				Type.Literal("user"),
				Type.Literal("assistant"),
				Type.Literal("tool"),
				Type.Literal("system"),
				Type.Literal("developer"),
				Type.Null(),
			]),
		),
		tool_name: Type.Optional(nullableString),
		tool_namespace: Type.Optional(nullableString),
		window_id: Type.Optional(
			Type.Union([Type.String(), Type.Null()], {
				description: "Required with item_id for read",
			}),
		),
	},
	{ additionalProperties: false },
);

export const notesParameters = Type.Object(
	{
		action: Type.Optional(
			Type.Union(NOTES_ACTIONS.map((action) => Type.Literal(action))),
		),
		target,
		agent_name: Type.Optional(nullableString),
		file_order: Type.Optional(
			Type.Union([Type.Literal("ascending"), Type.Literal("descending")]),
		),
		file_order_by: Type.Optional(
			Type.Union([
				Type.Literal("name"),
				Type.Literal("created_at"),
				Type.Literal("updated_at"),
			]),
		),
		limit: Type.Optional(positiveInteger),
		max_matches_per_file: Type.Optional(positiveInteger),
		path: Type.Optional(
			Type.Union([Type.String(), Type.Null()], {
				description: "File for read/write/append; prefix for list/search",
			}),
		),
		query: Type.Optional(Type.String()),
		recent_file_first: Type.Optional(Type.Boolean()),
		start_line: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
		stop_line: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
		limit_chars: Type.Optional(positiveInteger),
		offset_chars: Type.Optional(Type.Integer({ minimum: 0 })),
		text: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

export type NotesArguments = Static<typeof notesParameters>;
export type HistoryArguments = Static<typeof historyParameters>;

export const newContextParameters = Type.Object(
	{ role: Type.Optional(Type.String({ minLength: 1 })) },
	{ additionalProperties: false },
);

export function prepareNewContextArguments(input: unknown) {
	const args = input ?? {};
	if (!Check(newContextParameters, args))
		throw new Error(
			'Use {} to keep the current model, or {role: "name"} for a configured role.',
		);
	return args;
}

export function prepareNotesArguments(input: unknown): NotesArguments {
	const args = normalizeQueryInput("notes", input);
	if (!Check(notesParameters, args))
		throw new Error("Supply valid notes arguments; omit arguments for help");
	return args;
}

export function prepareHistoryArguments(input: unknown): HistoryArguments {
	const args = normalizeQueryInput("history", input);
	if (!Check(historyParameters, args))
		throw new Error("Supply valid history arguments; omit arguments for help");
	return args;
}

const notesFields = {
	help: [],
	list: ["file_order", "file_order_by", "limit", "path"],
	read: ["path", "start_line", "stop_line", "limit_chars", "offset_chars"],
	search: [
		"limit",
		"max_matches_per_file",
		"path",
		"query",
		"recent_file_first",
	],
	append: ["path", "text"],
	write: ["path", "text"],
} satisfies Record<NonNullable<NotesArguments["action"]>, readonly string[]>;
const historyFields = {
	help: [],
	list_windows: ["limit", "recent_first"],
	list: [
		"limit",
		"max_chars_per_item",
		"recent_first",
		"role",
		"tool_name",
		"tool_namespace",
		"window_id",
	],
	read: ["item_id", "limit_chars", "offset_chars", "window_id"],
	search: [
		"limit",
		"query",
		"recent_first",
		"role",
		"tool_name",
		"tool_namespace",
		"window_id",
	],
} satisfies Record<NonNullable<HistoryArguments["action"]>, readonly string[]>;

export function contextToolHelp(
	namespace: "notes" | "history",
	args: NotesArguments | HistoryArguments,
	rankedHistory = false,
) {
	if (Object.keys(args).length && args.action !== "help") return undefined;
	if (Object.keys(args).some((key) => key !== "action"))
		throw new Error("Help accepts only action: help");
	const fields = namespace === "notes" ? notesFields : historyFields;
	return {
		actions: Object.fromEntries(
			Object.entries(fields).map(([action, names]) => [
				action,
				names
					.map((name) =>
						(name === "path"
							? ["read", "write", "append"].includes(action)
							: ["text", "query", "item_id"].includes(name)) ||
						(action === "read" && name === "window_id")
							? name
							: `${name}?`,
					)
					.join(" "),
			]),
		),
		target:
			"Durable conversation ID; defaults to caller; reads require the same Context visibility group; write own",
		...(namespace === "notes"
			? {
					writes: "write replaces; append adds",
					paths:
						"Paths are relative to /notes; target selects a conversation, read-only unless your own",
					usage: '{ "action": "read", "path": "checkpoint" }',
					ranges:
						"start_line/stop_line inclusive, 1-based; negative counts from end; 0/null/omitted uses first/last line; out-of-range clamps; reversed range returns empty content",
					paging:
						"read returns the full selected lines by default. Optional limit_chars and offset_chars select a page; continue with next_offset_chars and the same line range",
					defaults:
						"list limit 20; search limit/max_matches_per_file 20; positive limits capped at 100; list name ascending; search name ascending, recent_file_first sorts created_at descending",
				}
			: {
					usage:
						"Search earlier conversation, don't browse it. Pass returned IDs unchanged",
					search: rankedHistory
						? "Own earlier conversation: user/assistant visible text, all keywords, case/accent-insensitive, relevance order. Explicit live/tool/metadata scopes or agent_name: case-sensitive literal substring. list/read retain the full transcript. recent_first=true uses newest first"
						: "Case-sensitive literal substring. recent_first=true uses newest first",
				}),
	};
}

export function validateNotesArguments(args: NotesArguments): void {
	validateFields(
		"notes",
		args,
		args.action === undefined ? [] : notesFields[args.action],
	);
	if (
		args.action === "read" ||
		args.action === "append" ||
		args.action === "write"
	)
		requiredString(args.path, `notes ${args.action} requires path`);
	if (args.action === "search")
		requiredString(args.query, "notes search requires query");
	if (args.action === "append" || args.action === "write")
		requiredString(args.text, `notes ${args.action} requires text`, true);
}

export function validateHistoryArguments(args: HistoryArguments): void {
	validateFields(
		"history",
		args,
		args.action === undefined ? [] : historyFields[args.action],
	);
	if (args.action === "read") {
		const hint =
			" as a string. Copy window_id and item_id from the same search or list result";
		requiredString(args.window_id, `history read requires window_id${hint}`);
		requiredString(args.item_id, `history read requires item_id${hint}`);
	}
	if (args.action === "search")
		requiredString(args.query, "history search requires query");
}

function validateFields(
	namespace: string,
	args: { action?: string },
	fields: readonly string[],
): void {
	if (!fields || args.action === undefined)
		throw new Error(`${namespace} requires a supported action`);
	const unexpected = Object.keys(args).find(
		(key) =>
			key !== "action" &&
			key !== "target" &&
			key !== "agent_name" &&
			!fields.includes(key),
	);
	if (unexpected)
		throw new Error(
			`${namespace} ${args.action} does not accept ${unexpected}`,
		);
}

export function targetConversationId(
	value: string | undefined,
	caller: ConversationId,
): ConversationId {
	if (value === undefined) return caller;
	if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))
		throw new Error(
			"target must be a positive safe-integer Durable conversation ID",
		);
	return Number(value) as ConversationId;
}

export function requiredString(
	value: unknown,
	message: string,
	allowEmpty = false,
): string {
	if (typeof value !== "string" || (!allowEmpty && value === ""))
		throw new Error(message);
	return value;
}

export function boundedInteger(
	value: unknown,
	fallback: number,
	maximum: number,
	minimum = 1,
): number {
	return typeof value === "number" && Number.isInteger(value)
		? Math.max(minimum, Math.min(value, maximum))
		: fallback;
}
