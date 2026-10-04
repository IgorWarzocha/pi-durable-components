// Adapted from pi-codex-conversion, Copyright (c) 2026 Igor Warzocha, MIT.
import { type Static, Type } from "typebox";

const HISTORY_ACTIONS = [
	"list_windows",
	"list_items",
	"read_item",
	"search_contents",
] as const;
const NOTES_ACTIONS = [
	"list_files_by_prefix",
	"read_file",
	"search_contents",
	"append_to_file",
	"write_file",
] as const;

const nullableString = Type.Union([Type.String(), Type.Null()]);
const positiveInteger = Type.Integer({ minimum: 1 });

export const historyParameters = Type.Object(
	{
		action: Type.Union(HISTORY_ACTIONS.map((action) => Type.Literal(action))),
		item_id: Type.Optional(Type.String()),
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
		window_id: Type.Optional(nullableString),
	},
	{ additionalProperties: false },
);

export const notesParameters = Type.Object(
	{
		action: Type.Union(NOTES_ACTIONS.map((action) => Type.Literal(action))),
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

const notesFields = {
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
} satisfies Record<NotesArguments["action"], readonly string[]>;
const historyFields = {
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
} satisfies Record<HistoryArguments["action"], readonly string[]>;

export function validateNotesArguments(args: NotesArguments): void {
	validateFields("notes", args, notesFields[args.action]);
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
	validateFields("history", args, historyFields[args.action]);
	if (args.action === "read_item") {
		requiredString(args.item_id, "history read_item requires item_id");
		requiredString(args.window_id, "history read_item requires window_id");
	}
	if (args.action === "search_contents")
		requiredString(args.query, "history search_contents requires query");
}

function validateFields(
	namespace: string,
	args: { action: string },
	fields: readonly string[],
): void {
	const unexpected = Object.keys(args).find(
		(key) => key !== "action" && !fields.includes(key),
	);
	if (unexpected)
		throw new Error(
			`${namespace} ${args.action} does not accept ${unexpected}`,
		);
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
