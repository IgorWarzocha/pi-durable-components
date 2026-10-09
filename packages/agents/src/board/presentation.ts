/** Host-selected board and channel page. Acquiring data and authorizing calls remain host-owned. */
export interface BoardPostPreview {
	message_id: string;
	thread_id: string;
	channel_name: string;
	author: string;
	created_at: string;
	text_preview: string;
	n_chars: number;
	truncated: boolean;
}
export interface BoardThreadSummary {
	thread_id: string;
	root_post: BoardPostPreview;
	reply_count: number;
	last_activity_at: string;
	latest_reply: BoardPostPreview | null;
}
export interface BoardPresentationState {
	board_id: string;
	channel_name: string;
	threads: BoardThreadSummary[];
	has_more: boolean;
	next_cursor: string | null;
	detail: {
		thread_id: string;
		root_post: BoardPostPreview;
		results: BoardPostPreview[];
		has_more: boolean;
		next_cursor: string | null;
	} | null;
}

function object(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new TypeError("Expected a board object");
	return Object.fromEntries(Object.entries(value));
}
function string(value: unknown): string {
	if (typeof value !== "string") throw new TypeError("Expected a board string");
	return value;
}
function count(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw new TypeError("Expected a non-negative board count");
	return value;
}
function boolean(value: unknown): boolean {
	if (typeof value !== "boolean")
		throw new TypeError("Expected a board boolean");
	return value;
}
function array<T>(value: unknown, parse: (item: unknown) => T): T[] {
	if (!Array.isArray(value)) throw new TypeError("Expected a board array");
	return value.map(parse);
}
function page(item: Record<string, unknown>) {
	const has_more = boolean(item["has_more"]);
	const next_cursor =
		item["next_cursor"] === null ? null : string(item["next_cursor"]);
	if (has_more !== (next_cursor !== null))
		throw new TypeError("Invalid board continuation");
	return { has_more, next_cursor };
}
function post(value: unknown): BoardPostPreview {
	const item = object(value);
	return {
		message_id: string(item["message_id"]),
		thread_id: string(item["thread_id"]),
		channel_name: string(item["channel_name"]),
		author: string(item["author"]),
		created_at: string(item["created_at"]),
		text_preview: string(item["text_preview"]),
		n_chars: count(item["n_chars"]),
		truncated: boolean(item["truncated"]),
	};
}
function belongs(
	value: BoardPostPreview,
	thread: string,
	channel: string,
	root = false,
) {
	if (
		value.thread_id !== thread ||
		value.channel_name !== channel ||
		(root && value.message_id !== thread)
	)
		throw new TypeError("Board post is outside the selected thread");
}
export function parseBoardPresentationState(
	value: unknown,
): BoardPresentationState {
	const state = object(value);
	const board_id = string(state["board_id"]);
	const channel_name = string(state["channel_name"]);
	const threads = array(state["threads"], (value): BoardThreadSummary => {
		const item = object(value);
		const thread_id = string(item["thread_id"]);
		const root_post = post(item["root_post"]);
		const latest_reply =
			item["latest_reply"] === null ? null : post(item["latest_reply"]);
		belongs(root_post, thread_id, channel_name, true);
		if (latest_reply !== null) belongs(latest_reply, thread_id, channel_name);
		return {
			thread_id,
			root_post,
			latest_reply,
			reply_count: count(item["reply_count"]),
			last_activity_at: string(item["last_activity_at"]),
		};
	});
	let detail: BoardPresentationState["detail"] = null;
	if (state["detail"] !== null) {
		const item = object(state["detail"]);
		const thread_id = string(item["thread_id"]);
		if (!threads.some((thread) => thread.thread_id === thread_id))
			throw new TypeError(
				"Detail thread is absent from the supplied board page",
			);
		const root_post = post(item["root_post"]);
		const results = array(item["results"], post);
		belongs(root_post, thread_id, channel_name, true);
		for (const reply of results) belongs(reply, thread_id, channel_name);
		detail = { thread_id, root_post, results, ...page(item) };
	}
	return { board_id, channel_name, threads, detail, ...page(state) };
}
export const boardCapability = {
	id: "board",
	version: 1,
	parseState: parseBoardPresentationState,
	actions: ["board"],
	streams: [],
	presentations: ["board.summary", "board.detail"],
};
export const boardSummaryPresentation = {
	id: "board.summary",
	requests: ["board.detail"],
	select: ({ detail: _detail, ...summary }: BoardPresentationState) => summary,
};
export const boardDetailPresentation = {
	id: "board.detail",
	requests: [],
	select: (state: BoardPresentationState) => state.detail,
};
