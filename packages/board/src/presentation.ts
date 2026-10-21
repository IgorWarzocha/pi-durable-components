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
export interface BoardDerivedSummary {
	thread_id: string;
	status_message_id: string;
	through_message_id: string;
	created_at: string;
	has_newer_posts: boolean;
	text_preview: string;
	n_chars: number;
	truncated: boolean;
	offset_chars?: number;
}
type Status = {
	status: "open" | "completed" | "abandoned";
	status_message_id: string | null;
};
export type BoardThreadSummary = Status & {
	thread_id: string;
	reply_count: number;
	last_activity_at: string;
} & (
		| {
				root_post: BoardPostPreview;
				latest_reply: BoardPostPreview | null;
				summary?: never;
		  }
		| { summary: BoardDerivedSummary; root_post?: never; latest_reply?: never }
	);
type PostMetadata = Omit<
	BoardPostPreview,
	"text_preview" | "n_chars" | "truncated"
>;
export interface BoardPresentationState {
	board_id: string;
	channel_name: string;
	threads: BoardThreadSummary[];
	has_more: boolean;
	next_cursor: string | null;
	detail:
		| (Status & {
				thread_id: string;
				has_more: boolean;
				next_cursor: string | null;
		  } & (
					| {
							view: "full";
							root_post: BoardPostPreview;
							results: BoardPostPreview[];
							summary?: never;
					  }
					| {
							view: "summary";
							root_post: PostMetadata;
							summary: BoardDerivedSummary;
							results?: never;
					  }
				))
		| null;
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
function postMetadata(value: unknown): PostMetadata {
	const item = object(value);
	return {
		message_id: string(item["message_id"]),
		thread_id: string(item["thread_id"]),
		channel_name: string(item["channel_name"]),
		author: string(item["author"]),
		created_at: string(item["created_at"]),
	};
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
	value: PostMetadata,
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
function status(item: Record<string, unknown>): Status {
	const value = item["status"] ?? "open";
	if (value !== "open" && value !== "completed" && value !== "abandoned")
		throw new TypeError("Invalid thread status");
	return {
		status: value,
		status_message_id:
			item["status_message_id"] == null
				? null
				: string(item["status_message_id"]),
	};
}
function summary(value: unknown, thread: string): BoardDerivedSummary {
	const item = object(value);
	const result = {
		thread_id: string(item["thread_id"]),
		status_message_id: string(item["status_message_id"]),
		through_message_id: string(item["through_message_id"]),
		created_at: string(item["created_at"]),
		has_newer_posts: boolean(item["has_newer_posts"]),
		text_preview: string(item["text_preview"]),
		n_chars: count(item["n_chars"]),
		truncated: boolean(item["truncated"]),
		...(item["offset_chars"] === undefined
			? {}
			: { offset_chars: count(item["offset_chars"]) }),
	};
	if (result.thread_id !== thread)
		throw new TypeError("Summary is outside selected thread");
	return result;
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
		const common = {
			thread_id,
			...status(item),
			reply_count: count(item["reply_count"]),
			last_activity_at: string(item["last_activity_at"]),
		};
		if (item["summary"] !== undefined)
			return { ...common, summary: summary(item["summary"], thread_id) };
		const root_post = post(item["root_post"]);
		const latest_reply =
			item["latest_reply"] === null ? null : post(item["latest_reply"]);
		belongs(root_post, thread_id, channel_name, true);
		if (latest_reply) belongs(latest_reply, thread_id, channel_name);
		return { ...common, root_post, latest_reply };
	});
	let detail: BoardPresentationState["detail"] = null;
	if (state["detail"] !== null) {
		const item = object(state["detail"]);
		const thread_id = string(item["thread_id"]);
		if (!threads.some((thread) => thread.thread_id === thread_id))
			throw new TypeError("Detail thread is absent from supplied board page");
		const common = { thread_id, ...status(item), ...page(item) };
		if (item["view"] === "summary") {
			const root_post = postMetadata(item["root_post"]);
			belongs(root_post, thread_id, channel_name, true);
			detail = {
				...common,
				view: "summary",
				root_post,
				summary: summary(item["summary"], thread_id),
			};
		} else {
			if (item["view"] !== undefined && item["view"] !== "full")
				throw new TypeError("Invalid thread view");
			const root_post = post(item["root_post"]);
			belongs(root_post, thread_id, channel_name, true);
			const results = array(item["results"], post);
			for (const reply of results) belongs(reply, thread_id, channel_name);
			detail = { ...common, view: "full", root_post, results };
		}
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
