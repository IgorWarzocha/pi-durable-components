import type { Context } from "@earendil-works/chord";
import type {
	ConversationId,
	DocumentReader,
	Storage,
} from "@earendil-works/pi-durable";
import { createSession } from "@earendil-works/pi-durable";
import {
	BoardCatalog,
	BoardIndex,
	type BoardRecord,
	comparePosts,
	PostText,
	textKey,
} from "./store-model.ts";

export type SavedPost = {
	messageId: string;
	author: string;
	createdAt: string;
	text: string;
};
export type SavedThread = {
	boardId: string;
	threadId: string;
	channel: string;
	posts: SavedPost[];
};

/**
 * Supply an immutable storage view for coherent catalog/body reads. Storage stays caller-owned.
 * Includes archived boards owned by this root, never another tree's conversations.
 */
export async function readSavedThreads(
	storage: Storage,
	rootConversationId: ConversationId,
	context: Context,
): Promise<SavedThread[]> {
	const reader = createSession(storage);
	const catalog = await reader.snapshot(BoardCatalog, context);
	const threads: SavedThread[] = [];
	const boards = new Set<string>();
	for (const board of catalog?.boards ?? []) {
		if (board.root_conversation_id !== rootConversationId) continue;
		if (boards.has(board.board_id))
			throw new Error(`Duplicate saved board: ${board.board_id}`);
		boards.add(board.board_id);
		threads.push(...(await readBoardThreads(reader, board, context)));
	}
	return threads;
}

async function readBoardThreads(
	reader: DocumentReader,
	board: BoardRecord,
	context: Context,
): Promise<SavedThread[]> {
	const index = await reader.snapshot(BoardIndex, board.board_id, context);
	if (
		index === undefined ||
		index.posts.length !== board.message_count ||
		index.channels.length !== board.channel_count
	)
		throw new Error(`Saved board catalog/index mismatch: ${board.board_id}`);
	const channels = new Set(index.channels.map((channel) => channel.name));
	const threads = new Map<string, SavedThread>();
	const ordered = index.posts.toSorted(comparePosts);
	for (const post of ordered) {
		if (post.message_id !== post.thread_id) continue;
		threads.set(post.thread_id, {
			boardId: board.board_id,
			threadId: post.thread_id,
			channel: post.channel_name,
			posts: [],
		});
	}
	const messages = new Set<string>();
	for (const post of ordered) {
		context.abortSignal?.throwIfAborted();
		const thread = threads.get(post.thread_id);
		if (
			messages.has(post.message_id) ||
			thread === undefined ||
			thread.channel !== post.channel_name ||
			!channels.has(post.channel_name)
		)
			throw new Error(`Saved board post index mismatch: ${post.message_id}`);
		const body = await reader.snapshot(
			PostText,
			textKey(board.board_id, post.message_id),
			context,
		);
		if (body === undefined)
			throw new Error(`Missing saved board post body: ${post.message_id}`);
		messages.add(post.message_id);
		const saved = {
			messageId: post.message_id,
			author: post.author,
			createdAt: post.created_at,
			text: body.text,
		};
		// The opening stays first even if the host clock moved backwards for a reply.
		if (post.message_id === post.thread_id) thread.posts.unshift(saved);
		else thread.posts.push(saved);
	}
	return [...threads.values()];
}
