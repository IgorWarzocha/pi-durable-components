import { copyJson } from "@earendil-works/chord";
import type {
	ConversationId,
	JsonObject,
	TaskId,
} from "@earendil-works/pi-durable";
import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable";
import type { PostRecord } from "./paging.ts";

export type BoardRecord = {
	board_id: string;
	root_conversation_id: ConversationId;
	owner_folder: string;
	created_at: string;
	last_activity_at: string;
	channel_count: number;
	message_count: number;
};
type ChannelRecord = {
	name: string;
	name_search: string;
	created_at: string;
	author: string;
};
export type PostIndex = Omit<PostRecord, "text"> & { seq: number };
export type BoardIndexValue = {
	has_thread_states?: boolean;
	channels: ChannelRecord[];
	posts: PostIndex[];
	subscriptions: { target: string; agent: string; enabled: boolean }[];
};

// Only materialized boards belong here. Reading help/history never adds a board.
export const BoardCatalog = defineDoc<{ boards: BoardRecord[] }>({
	kind: "howaboua.agents.board.catalog",
	version: 1,
	scope: "session",
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
	initial: () => ({ boards: [] }),
});
export const BoardIndex = defineDocFamily<
	BoardIndexValue,
	BoardIndexValue | null
>({
	kind: "howaboua.agents.board.index",
	version: 1,
	scope: "session",
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
	family: true,
	initial: (seed) => {
		if (seed === null) throw new Error("Missing board index");
		return seed;
	},
});
type PostTextValue = { text: string; body_search: string };
export const PostText = defineDocFamily<PostTextValue, PostTextValue | null>({
	kind: "howaboua.agents.board.post-text",
	version: 1,
	scope: "session",
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
	family: true,
	initial: (seed) => {
		if (seed === null) throw new Error("Missing board post text");
		return seed;
	},
});

// A task owns exactly one mutation. Receipts cover channel and subscription writes,
// not only posts, so a stale replay cannot undo a later unsubscribe.
export const MutationReceipt = defineDoc<{
	saved: { request: string; value: JsonObject } | null;
}>({
	kind: "howaboua.agents.board.mutation",
	version: 1,
	scope: "task",
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
	initial: () => ({ saved: null }),
});

export function emptyIndex(): BoardIndexValue {
	return { channels: [], posts: [], subscriptions: [] };
}
export function textKey(board: string, message: string): string {
	return `${board}:${message}`;
}
export function detached(value: JsonObject): JsonObject {
	const copy = copyJson(value);
	if (copy === null || typeof copy !== "object" || Array.isArray(copy))
		throw new Error("Invalid board result");
	return copy;
}

// SQLite source ordering uses BINARY collation, not locale-sensitive comparison.
export function compareText(a: string, b: string): number {
	return Buffer.compare(Buffer.from(a), Buffer.from(b));
}
export function comparePosts(a: PostIndex, b: PostIndex): number {
	return compareText(a.created_at, b.created_at) || a.seq - b.seq;
}
export function findPost(index: BoardIndexValue, id: string): PostIndex {
	const post = index.posts.find((value) => value.message_id === id);
	if (post === undefined) throw new Error("Post not found in this board");
	return post;
}
export function findRoot(index: BoardIndexValue, id: string): PostIndex {
	const post = findPost(index, id);
	if (post.thread_id !== id)
		throw new Error("thread_id must identify a first post");
	return post;
}
export function channelValue(index: BoardIndexValue, name: string) {
	const channel = index.channels.find((value) => value.name === name);
	if (channel === undefined) throw new Error("Channel not found in this board");
	const posts = index.posts.filter((value) => value.channel_name === name);
	const last = posts.sort(comparePosts).at(-1);
	return {
		channel_name: channel.name,
		created_at: channel.created_at,
		created_by: channel.author,
		message_count: posts.length,
		last_message_id: last?.message_id ?? null,
	};
}

export type ThreadStatus = "open" | "completed" | "abandoned";
export type ThreadSummary = {
	thread_id: string;
	status_message_id: string;
	through_message_id: string;
	created_at: string;
	provider: string;
	model: string;
	reasoning: string;
	text: string;
};
/** Additive derived state: existing document identities and original posts remain. */
export type ThreadStatesValue = {
	threads: Record<
		string,
		{
			status: ThreadStatus;
			status_message_id: string;
			summary: ThreadSummary | null;
			task_id: TaskId | null;
		}
	>;
};
export const ThreadStates = defineDocFamily<ThreadStatesValue, null>({
	kind: "howaboua.board.thread-states",
	version: 1,
	scope: "session",
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
	family: true,
	initial: () => ({ threads: {} }),
});
export function threadStatus(
	state: { status: ThreadStatus; status_message_id: string } | undefined,
) {
	return {
		status: state?.status ?? "open",
		status_message_id: state?.status_message_id ?? null,
	};
}
export function summaryPreview(summary: ThreadSummary, chars: number) {
	const {
		text,
		provider: _provider,
		model: _model,
		reasoning: _reasoning,
		...value
	} = summary;
	const points = Array.from(text);
	return {
		...value,
		has_newer_posts: false,
		text_preview: points.slice(0, chars).join(""),
		n_chars: points.length,
		truncated: points.length > chars,
	};
}
