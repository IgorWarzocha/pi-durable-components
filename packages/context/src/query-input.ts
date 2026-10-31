// Adapted from Pi Stuff e4aa5bb4, Copyright (c) 2026 Igor Warzocha, MIT.

const actions = {
	notes: {
		list_files_by_prefix: "list",
		read_file: "read",
		search_contents: "search",
		append_to_file: "append",
		write_file: "write",
	},
	history: { list_items: "list", read_item: "read", search_contents: "search" },
} satisfies Record<string, Record<string, string>>;
const presentation = [
	"limit",
	"max_results",
	"max_files",
	"max_matches_per_file",
	"file_order",
	"file_order_by",
	"recent_file_first",
	"recent_first",
	"limit_chars",
	"max_chars_per_item",
];
const usedPresentation: Record<string, readonly string[]> = {
	"notes:list": ["limit", "file_order", "file_order_by"],
	"notes:search": ["limit", "max_matches_per_file", "recent_file_first"],
	"notes:read": ["start_line", "stop_line", "limit_chars", "offset_chars"],
	"history:list_windows": ["limit", "recent_first"],
	"history:list": ["limit", "recent_first", "max_chars_per_item"],
	"history:search": ["limit", "recent_first"],
	"history:read": ["limit_chars", "offset_chars"],
};

function alias(params: Record<string, unknown>, from: string, to: string) {
	if (!(from in params)) return;
	if (to in params && params[to] !== params[from])
		throw new Error(`Conflicting ${to} and ${from}; supply only ${to}`);
	params[to] = params[from];
	delete params[from];
}

export function normalizeQueryInput(
	namespace: "notes" | "history",
	input: unknown,
) {
	if (input === undefined) return {};
	if (typeof input === "string") {
		try {
			input = JSON.parse(input);
		} catch {
			throw new Error(
				"Supply an action object or valid JSON object; use {} for help",
			);
		}
	}
	if (!input || typeof input !== "object" || Array.isArray(input))
		throw new Error("Supply an action object; use {} for help");
	const params: Record<string, unknown> = { ...input };
	const aliases: Record<string, string> = actions[namespace];
	const action = aliases[String(params["action"])] ?? params["action"];
	if (action !== undefined) params["action"] = action;
	if (namespace === "notes") {
		if (action === "write" || action === "append")
			alias(params, "content", "text");
		if (action === "list" || action === "search") {
			alias(params, "prefix", "path");
			alias(params, "path_prefix", "path");
			alias(params, "max_results", "limit");
			alias(params, "max_files", "limit");
			if (action === "search")
				alias(params, "recent_first", "recent_file_first");
		}
	} else if (["list", "search", "list_windows"].includes(String(action))) {
		alias(params, "max_results", "limit");
	}
	const used = usedPresentation[`${namespace}:${String(action)}`] ?? [];
	for (const hint of presentation)
		if (!used.includes(hint)) delete params[hint];
	return params;
}

/** Failed write attempts still invalidate freshness even when preparation rejected their fields. */
export function isNoteWrite(input: unknown): boolean {
	try {
		if (typeof input === "string") input = JSON.parse(input);
		return (
			!!input &&
			typeof input === "object" &&
			"action" in input &&
			["write", "append", "write_file", "append_to_file"].includes(
				String(input.action),
			)
		);
	} catch {
		return false;
	}
}
