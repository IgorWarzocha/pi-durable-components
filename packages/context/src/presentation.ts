/** Inventory and an optional bounded read_file result, not management's persisted state. */
export interface ContextNoteItem {
	path: string;
	bytes: number;
	created_at: string;
	updated_at: string;
}
export interface ContextPresentationState {
	files: ContextNoteItem[];
	detail:
		| (ContextNoteItem & {
				content: string;
				start_line: number;
				stop_line: number;
				total_lines: number;
		  })
		| null;
}

function object(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new TypeError("Expected an object");
	return Object.fromEntries(Object.entries(value));
}
function string(value: unknown): string {
	if (typeof value !== "string") throw new TypeError("Expected a string");
	return value;
}
function array<T>(value: unknown, parse: (item: unknown) => T): T[] {
	if (!Array.isArray(value)) throw new TypeError("Expected an array");
	return value.map(parse);
}

function integer(value: unknown, minimum = 0): number {
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < minimum
	)
		throw new TypeError("Expected a non-negative safe integer");
	return value;
}
function parseNote(value: unknown): ContextNoteItem {
	const item = object(value);
	const path = string(item["path"]);
	if (
		!path.startsWith("/notes/") ||
		path.split("/").some((part) => part === "." || part === "..")
	)
		throw new TypeError("Expected a normalized virtual note path");
	const created_at = string(item["created_at"]);
	const updated_at = string(item["updated_at"]);
	if (
		!Number.isFinite(Date.parse(created_at)) ||
		!Number.isFinite(Date.parse(updated_at))
	)
		throw new TypeError("Invalid note timestamp");
	return { path, bytes: integer(item["bytes"]), created_at, updated_at };
}
export function parseContextPresentationState(
	value: unknown,
): ContextPresentationState {
	const state = object(value);
	const files = array(state["files"], parseNote);
	let detail: ContextPresentationState["detail"] = null;
	if (state["detail"] !== null) {
		const item = object(state["detail"]);
		const start_line = integer(item["start_line"], 1);
		const stop_line = integer(item["stop_line"], 1);
		if (stop_line < start_line) throw new TypeError("Invalid note line range");
		detail = {
			...parseNote(item),
			content: string(item["content"]),
			start_line,
			stop_line,
			total_lines: integer(item["total_lines"], 1),
		};
		const metadata = files.find((file) => file.path === detail?.path);
		if (
			!metadata ||
			metadata.bytes !== detail.bytes ||
			metadata.updated_at !== detail.updated_at ||
			metadata.created_at !== detail.created_at
		)
			throw new TypeError("Note detail does not match the inventory");
	}
	return { files, detail };
}
export const contextCapability = {
	id: "context.notes",
	version: 1,
	parseState: parseContextPresentationState,
	actions: ["notes"],
	streams: [],
	presentations: ["context.notes.summary", "context.notes.detail"],
};
export const contextSummaryPresentation = {
	id: "context.notes.summary",
	requests: ["context.notes.detail"],
	select(state: ContextPresentationState) {
		return {
			count: state.files.length,
			bytes: state.files.reduce((sum, file) => sum + file.bytes, 0),
			files: state.files,
		};
	},
};
export const contextDetailPresentation = {
	id: "context.notes.detail",
	requests: [],
	select: (state: ContextPresentationState) => state.detail,
};
