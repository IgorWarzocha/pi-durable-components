import type { JsonObject, Tx } from "@earendil-works/pi-durable";
import { caseFold } from "unicode-case-folding";
import { agentPath, type BoardParams, required } from "./contract.ts";
import { budget, metadata, page, preview, window } from "./paging.ts";
import {
	BoardCatalog,
	BoardIndex,
	type BoardIndexValue,
	channelValue,
	comparePosts,
	compareText,
	emptyIndex,
	findPost,
	findRoot,
	type PostIndex,
	PostText,
	textKey,
} from "./store-model.ts";

async function loadPost(tx: Tx, board: string, post: PostIndex) {
	const body = await tx.doc(PostText, textKey(board, post.message_id), null);
	return {
		message_id: post.message_id,
		channel_name: post.channel_name,
		author: post.author,
		thread_id: post.thread_id,
		created_at: post.created_at,
		text: body.text,
	};
}

function slicePage<T>(values: T[], params: BoardParams): T[] {
	const { limit, offset } = window(params);
	return values.slice(offset, offset + limit + 1);
}

export async function queryBoard(
	tx: Tx,
	ownBoard: string,
	params: BoardParams,
): Promise<JsonObject> {
	const catalog = await tx.doc(BoardCatalog);
	const board = params.board_id ?? ownBoard;
	const { limit } = window(params);
	const direction = params.recent_first === false ? 1 : -1;
	if (params.action === "list_boards") {
		const rows = [...catalog.boards].sort(
			(a, b) =>
				compareText(b.last_activity_at, a.last_activity_at) ||
				compareText(b.board_id, a.board_id),
		);
		return page(
			slicePage(rows, params).map((row) => ({
				...row,
				current: row.board_id === ownBoard,
			})),
			params,
		);
	}
	if (catalog.boards.length === 0) {
		if (
			params.action === "search_posts" &&
			params.after_message_id !== undefined
		)
			throw new Error("Post not found in this board");
		if (params.action === "get_channels" || params.action === "search_posts")
			return page([], params);
		throw new Error("This board has no channels or posts yet");
	}
	const index = catalog.boards.some((row) => row.board_id === board)
		? await tx.doc(BoardIndex, board, null)
		: emptyIndex();
	if (params.action === "get_channels") {
		const activity = (name: string, created: string) =>
			index.posts
				.filter((post) => post.channel_name === name)
				.map((post) => post.created_at)
				.sort(compareText)
				.at(-1) ?? created;
		const rows = index.channels
			.filter((channel) =>
				channel.name_search.includes(caseFold(params.query ?? "")),
			)
			.sort(
				(a, b) =>
					direction *
					(compareText(
						activity(a.name, a.created_at),
						activity(b.name, b.created_at),
					) || compareText(a.name, b.name)),
			);
		return page(
			slicePage(rows, params).map((row) => channelValue(index, row.name)),
			params,
		);
	}
	if (params.action === "read_post") {
		const post = await loadPost(
			tx,
			board,
			findPost(index, required(params.message_id, "message_id")),
		);
		const chars = Array.from(post.text);
		const offset = Math.min(params.offset_chars ?? 0, chars.length);
		const text = chars
			.slice(offset, offset + Math.min(params.limit_chars ?? 20000, 20000))
			.join("");
		return {
			...metadata(post),
			text,
			n_chars: chars.length,
			next_offset_chars: offset + Array.from(text).length,
		};
	}
	if (params.action === "read_thread") {
		const root = findRoot(index, required(params.thread_id, "thread_id"));
		const replies = slicePage(
			index.posts
				.filter(
					(post) =>
						post.thread_id === root.message_id &&
						post.message_id !== post.thread_id,
				)
				.sort((a, b) => comparePosts(b, a)),
			params,
		);
		const chars = budget(params, Math.min(replies.length, limit) + 1);
		return {
			root_post: preview(await loadPost(tx, board, root), chars),
			...page(
				await Promise.all(
					replies.map(async (post) =>
						preview(await loadPost(tx, board, post), chars),
					),
				),
				params,
			),
		};
	}
	if (params.action === "list_threads")
		return listThreads(tx, board, index, params);
	if (params.action === "search_posts") return search(tx, board, index, params);
	throw new Error(`Unsupported board read: ${params.action}`);
}

async function listThreads(
	tx: Tx,
	board: string,
	index: BoardIndexValue,
	params: BoardParams,
): Promise<JsonObject> {
	const channel = channelValue(
		index,
		required(params.channel_name, "channel_name"),
	);
	const { limit } = window(params);
	const direction = params.recent_first === false ? 1 : -1;
	const activity = (root: PostIndex) =>
		index.posts
			.filter((post) => post.thread_id === root.message_id)
			.map((post) => post.created_at)
			.sort(compareText)
			.at(-1) ?? root.created_at;
	const roots = slicePage(
		index.posts
			.filter(
				(post) =>
					post.channel_name === channel.channel_name &&
					post.message_id === post.thread_id,
			)
			.sort(
				(a, b) =>
					direction *
					(compareText(
						params.sort === "activity" ? activity(a) : a.created_at,
						params.sort === "activity" ? activity(b) : b.created_at,
					) || a.seq - b.seq),
			),
		params,
	);
	const chars = budget(params, 2 * Math.min(roots.length, limit));
	return page(
		await Promise.all(
			roots.map(async (root) => {
				const replies = index.posts.filter(
					(post) =>
						post.thread_id === root.message_id &&
						post.message_id !== post.thread_id,
				);
				const reply = replies.sort(comparePosts).at(-1);
				return {
					thread_id: root.message_id,
					root_post: preview(await loadPost(tx, board, root), chars),
					reply_count: replies.length,
					last_activity_at:
						reply && reply.created_at > root.created_at
							? reply.created_at
							: root.created_at,
					latest_reply: reply
						? preview(await loadPost(tx, board, reply), chars)
						: null,
				};
			}),
		),
		params,
	);
}

async function search(
	tx: Tx,
	board: string,
	index: BoardIndexValue,
	params: BoardParams,
): Promise<JsonObject> {
	const { limit, offset } = window(params);
	const author =
		params.author === undefined ? undefined : agentPath(params.author, "/root");
	const after =
		params.after_message_id === undefined
			? undefined
			: findPost(index, params.after_message_id);
	const query = params.query === undefined ? undefined : caseFold(params.query);
	const candidates = index.posts
		.filter(
			(post) =>
				(params.channel_name === undefined ||
					post.channel_name === params.channel_name) &&
				(author === undefined || post.author === author) &&
				(after === undefined || comparePosts(post, after) > 0),
		)
		.sort((a, b) => comparePosts(b, a));
	const selected: PostIndex[] = [];
	let skipped = 0;
	for (const post of candidates) {
		if (query !== undefined) {
			const body = await tx.doc(
				PostText,
				textKey(board, post.message_id),
				null,
			);
			if (!body.body_search.includes(query)) continue;
		}
		if (skipped++ < offset) continue;
		selected.push(post);
		if (selected.length > limit) break;
	}
	const chars = budget(params, Math.min(selected.length, limit));
	return page(
		await Promise.all(
			selected.map(async (post) =>
				preview(await loadPost(tx, board, post), chars),
			),
		),
		params,
	);
}
