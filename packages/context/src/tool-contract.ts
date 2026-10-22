// Adapted from pi-codex-conversion, Copyright (c) 2026 Igor Warzocha, MIT.

import type { ConversationId, JsonObject } from "@earendil-works/pi-durable";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";

const HISTORY_ACTIONS = [
	"help",
	"list_windows",
	"list_items",
	"read_item",
	"search_contents",
] as const;
const NOTES_ACTIONS = [
	"help",
	"list_files_by_prefix",
	"read_file",
	"search_contents",
	"append_to_file",
	"write_file",
] as const;

/** Own the native output budget so discovery can reject oversize JSON before truncation. */
export const contextOutputLimits = { maxBytes: 50 * 1024, maxLines: 2_000 };

export function contextHelpText(help: JsonObject): string {
	const text = JSON.stringify(help);
	if (new TextEncoder().encode(text).byteLength > contextOutputLimits.maxBytes)
		throw new Error(
			"Remote Context discovery exceeds the tool output budget. Ask the host for a narrower catalogue. Known agent_name and numeric target operations remain available.",
		);
	return text;
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
				description: "Required with item_id for read_item",
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
		content: Type.Optional(Type.String()),
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
		max_files: Type.Optional(positiveInteger),
		max_matches_per_file: Type.Optional(positiveInteger),
		max_results: Type.Optional(positiveInteger),
		path: Type.Optional(Type.String()),
		path_prefix: Type.Optional(nullableString),
		prefix: Type.Optional(nullableString),
		query: Type.Optional(Type.String()),
		recent_file_first: Type.Optional(Type.Boolean()),
		start_line: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
		stop_line: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
		text: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

export type NotesArguments = Static<typeof notesParameters>;
export type HistoryArguments = Static<typeof historyParameters>;

export function prepareNotesArguments(input: unknown): NotesArguments {
	const args = input === undefined ? {} : input;
	if (!Check(notesParameters, args))
		throw new Error("Supply valid notes arguments; omit arguments for help");
	return args;
}

export function prepareHistoryArguments(input: unknown): HistoryArguments {
	const args = input === undefined ? {} : input;
	if (!Check(historyParameters, args))
		throw new Error("Supply valid history arguments; omit arguments for help");
	return args;
}

const notesFields = {
	help: [],
	list_files_by_prefix: [
		"file_order",
		"file_order_by",
		"max_results",
		"prefix",
	],
	read_file: ["path", "start_line", "stop_line"],
	search_contents: [
		"max_files",
		"max_matches_per_file",
		"path_prefix",
		"query",
		"recent_file_first",
	],
	append_to_file: ["path", "text"],
	write_file: ["path", "text"],
} satisfies Record<NonNullable<NotesArguments["action"]>, readonly string[]>;
const historyFields = {
	help: [],
	list_windows: ["limit", "recent_first"],
	list_items: [
		"limit",
		"max_chars_per_item",
		"recent_first",
		"role",
		"tool_name",
		"tool_namespace",
		"window_id",
	],
	read_item: ["item_id", "limit_chars", "offset_chars", "window_id"],
	search_contents: [
		"limit",
		"query",
		"recent_first",
		"role",
		"tool_name",
		"tool_namespace",
		"window_id",
	],
} satisfies Record<NonNullable<HistoryArguments["action"]>, readonly string[]>;

export function normalizeNotesArguments(args: NotesArguments): NotesArguments {
	const normalized = { ...args };
	if (args.action === "write_file" || args.action === "append_to_file") {
		if (normalized.text === undefined && normalized.content !== undefined)
			normalized.text = normalized.content;
		delete normalized.content;
	}
	if (args.action === "list_files_by_prefix") {
		if (
			normalized.max_results === undefined &&
			normalized.max_files !== undefined
		)
			normalized.max_results = normalized.max_files;
		delete normalized.max_files;
	}
	return normalized;
}

export function contextToolHelp(
	namespace: "notes" | "history",
	args: NotesArguments | HistoryArguments,
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
						["path", "text", "query", "item_id"].includes(name) ||
						(action === "read_item" && name === "window_id")
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
					writes: "write_file replaces; append_to_file adds",
					paths:
						"Paths are relative to /notes; target selects a conversation, read-only unless your own",
					usage: '{ "action": "read_file", "path": "checkpoint" }',
					ranges:
						"start_line/stop_line inclusive, 1-based; negative counts from end; 0/null/omitted uses first/last line; out-of-range clamps; reversed range returns empty content",
					defaults:
						"list max_results 20; search max_files/max_matches_per_file 20; positive limits capped at 100; list name ascending; search name ascending, recent_file_first sorts created_at descending",
				}
			: {
					usage:
						"Search earlier conversation, don't browse it. Pass returned IDs unchanged",
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
		args.action === "read_file" ||
		args.action === "append_to_file" ||
		args.action === "write_file"
	)
		requiredString(args.path, `notes ${args.action} requires path`);
	if (args.action === "search_contents")
		requiredString(args.query, "notes search_contents requires query");
	if (args.action === "append_to_file" || args.action === "write_file")
		requiredString(args.text, `notes ${args.action} requires text`, true);
}

export function validateHistoryArguments(args: HistoryArguments): void {
	validateFields(
		"history",
		args,
		args.action === undefined ? [] : historyFields[args.action],
	);
	if (args.action === "read_item") {
		const hint =
			" as a string. Copy window_id and item_id from the same search_contents or list_items result";
		requiredString(
			args.window_id,
			`history read_item requires window_id${hint}`,
		);
		requiredString(args.item_id, `history read_item requires item_id${hint}`);
	}
	if (args.action === "search_contents")
		requiredString(args.query, "history search_contents requires query");
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
