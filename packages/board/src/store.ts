import { randomUUID } from "node:crypto";
import type {
	ConversationId,
	JsonObject,
	TaskId,
	Tx,
} from "@earendil-works/pi-durable";
import { caseFold } from "unicode-case-folding";
import {
	agentPath,
	type BoardParams,
	boardHelp,
	MUTATIONS,
	parseBoardRequest,
	required,
} from "./contract.ts";
import { metadata, type PostRecord, preview } from "./paging.ts";
import { queryBoard } from "./queries.ts";
import {
	boundedBoardRead,
	checkMutationBudget,
	serializeBoardResult,
} from "./response.ts";
import {
	BoardCatalog,
	BoardIndex,
	type BoardIndexValue,
	channelValue,
	comparePosts,
	compareText,
	detached,
	emptyIndex,
	findRoot,
	MutationReceipt,
	PostText,
	textKey,
} from "./store-model.ts";

export type BoardScope = {
	boardId: string;
	rootConversationId: ConversationId;
	ownerFolder: string;
	agentName: string;
	callerConversationId: ConversationId;
	members: Readonly<Record<string, ConversationId>>;
};
export type BoardResult = {
	value: JsonObject;
	recipients: string[];
	notice?: JsonObject;
};

/** The caller commits this transaction together with active-recipient notices. */
export async function executeBoard(
	tx: Tx,
	scope: BoardScope,
	params: BoardParams,
	taskId: TaskId,
	now: () => number = Date.now,
): Promise<BoardResult> {
	params = parseBoardRequest(params);
	if (params.author !== undefined)
		params = { ...params, author: agentPath(params.author, scope.agentName) };
	if (params.action === "help") return { value: boardHelp, recipients: [] };
	if (!MUTATIONS.has(params.action)) {
		return boundedBoardRead(params, async (request) => ({
			value: detached(await queryBoard(tx, scope.boardId, request)),
			recipients: [],
		}));
	}
	checkMutationBudget(scope.agentName, params);
	const receipt = await tx.doc(MutationReceipt, taskId);
	const request = JSON.stringify({
		board: scope.boardId,
		caller: scope.callerConversationId,
		author: scope.agentName,
		params: Object.fromEntries(
			Object.entries({
				...params,
				...(params.action === "post"
					? { agents_to_notify: params.agents_to_notify ?? [] }
					: {}),
			}).sort(([a], [b]) => a.localeCompare(b)),
		),
	});
	if (receipt.saved !== null) {
		if (receipt.saved.request !== request)
			throw new Error(
				params.action === "post"
					? "Invocation ID already used for a different post"
					: "Invocation ID already used for a different board mutation",
			);
		return { value: detached(receipt.saved.value), recipients: [] };
	}
	validateMutation(params);
	for (const name of [
		...(params.agents_to_notify ?? []),
		...(params.target_agent === undefined ? [] : [params.target_agent]),
	])
		resolve(scope, name);
	const result = await mutate(tx, scope, params, now);
	// Budget failures abort the same transaction as all document writes.
	serializeBoardResult(result.value);
	const value = detached(result.value);
	receipt.saved = { request, value };
	return { ...result, value };
}

function resolve(scope: BoardScope, value: string): string {
	const path = agentPath(value, scope.agentName);
	if (!Object.hasOwn(scope.members, path))
		throw new Error(`Agent not bound to this tree: ${path}`);
	return path;
}

function subscription(
	index: BoardIndexValue,
	target: string,
	agent: string,
	enabled: boolean,
	implicit = false,
) {
	const previous = index.subscriptions.find(
		(item) => item.target === target && item.agent === agent,
	);
	if (previous === undefined)
		index.subscriptions.push({ target, agent, enabled });
	else if (!implicit) previous.enabled = enabled;
}

function insertChannel(
	index: BoardIndexValue,
	scope: BoardScope,
	name: string,
	created: string,
) {
	if (index.channels.some((channel) => channel.name === name))
		throw new Error("Channel already exists");
	index.channels.push({
		name,
		name_search: caseFold(name),
		created_at: created,
		author: scope.agentName,
	});
}

async function mutate(
	tx: Tx,
	scope: BoardScope,
	params: BoardParams,
	clock: () => number,
): Promise<BoardResult> {
	const catalog = await tx.doc(BoardCatalog);
	let board = catalog.boards.find((item) => item.board_id === scope.boardId);
	const creates =
		params.action === "create_channel" || params.new_channel_name !== undefined;
	if (board === undefined && !creates && catalog.boards.length === 0)
		throw new Error("This board has no channels or posts yet");
	const created = new Date(clock()).toISOString();
	const index =
		board === undefined
			? creates
				? await tx.doc(BoardIndex, scope.boardId, emptyIndex())
				: emptyIndex()
			: await tx.doc(BoardIndex, scope.boardId, null);
	if (board === undefined && creates) {
		board = {
			board_id: scope.boardId,
			root_conversation_id: scope.rootConversationId,
			owner_folder: scope.ownerFolder,
			created_at: created,
			last_activity_at: created,
			channel_count: 0,
			message_count: 0,
		};
		catalog.boards.push(board);
		// Work with the tracked overlay after insertion, not the detached seed.
		board = catalog.boards.find((item) => item.board_id === scope.boardId);
	}
	let result: BoardResult;
	if (params.action === "post") {
		result = await publish(tx, index, scope, params, created);
	} else if (params.action === "create_channel") {
		const name = required(params.channel_name, "channel_name");
		insertChannel(index, scope, name, created);
		if (params.subscribe !== false)
			subscription(index, `channel:${name}`, scope.agentName, true);
		result = { value: channelValue(index, name), recipients: [] };
	} else {
		result = changeSubscription(index, scope, params);
	}
	if (board !== undefined) {
		board.channel_count = index.channels.length;
		board.message_count = index.posts.length;
		// Preserve the source COALESCE(MAX(posts), MAX(channels), board.created_at),
		// including a newer empty channel not displacing existing post activity.
		board.last_activity_at =
			index.posts
				.map((post) => post.created_at)
				.sort(compareText)
				.at(-1) ??
			index.channels
				.map((channel) => channel.created_at)
				.sort(compareText)
				.at(-1) ??
			board.created_at;
	}
	return result;
}

function changeSubscription(
	index: BoardIndexValue,
	scope: BoardScope,
	params: BoardParams,
): BoardResult {
	const target_agent =
		params.target_agent === undefined
			? scope.agentName
			: resolve(scope, params.target_agent);
	const root =
		params.thread_id === undefined
			? undefined
			: findRoot(index, params.thread_id);
	const channel = channelValue(
		index,
		root?.channel_name ?? required(params.channel_name, "channel_name"),
	);
	const thread_id = root?.thread_id ?? null;
	const target = root
		? `thread:${root.thread_id}`
		: `channel:${channel.channel_name}`;
	const last = root
		? (index.posts
				.filter((post) => post.thread_id === root.thread_id)
				.sort(comparePosts)
				.at(-1)?.message_id ?? null)
		: channel.last_message_id;
	const enabled = params.action === "subscribe";
	subscription(index, target, target_agent, enabled);
	return {
		value: {
			channel_name: channel.channel_name,
			thread_id,
			target_agent,
			enabled,
			last_message_id: last,
		},
		recipients: [],
	};
}

async function publish(
	tx: Tx,
	index: BoardIndexValue,
	scope: BoardScope,
	params: BoardParams,
	created: string,
): Promise<BoardResult> {
	const recipients = new Set(
		(params.agents_to_notify ?? []).map((name) => resolve(scope, name)),
	);
	const id = randomUUID();
	let channel: string;
	let root: string = id;
	if (params.thread_id !== undefined) {
		const post = findRoot(index, params.thread_id);
		channel = post.channel_name;
		root = post.thread_id;
	} else if (params.new_channel_name !== undefined) {
		channel = params.new_channel_name;
		insertChannel(index, scope, channel, created);
		subscription(index, `channel:${channel}`, scope.agentName, true);
	} else
		channel = channelValue(
			index,
			required(params.channel_name, "channel_name"),
		).channel_name;
	const target = root === id ? `channel:${channel}` : `thread:${root}`;
	for (const item of index.subscriptions) {
		if (item.target === target && item.enabled) recipients.add(item.agent);
	}
	recipients.delete(scope.agentName);
	const post: PostRecord = {
		message_id: id,
		channel_name: channel,
		author: scope.agentName,
		thread_id: root,
		created_at: created,
		text: required(params.text, "text"),
	};
	await tx.doc(PostText, textKey(scope.boardId, id), {
		text: post.text,
		body_search: caseFold(post.text),
	});
	index.posts.push({ ...metadata(post), seq: index.posts.length + 1 });
	subscription(index, `thread:${root}`, scope.agentName, true, true);
	return {
		value: metadata(post),
		notice: preview(post, 150),
		recipients: [...recipients],
	};
}

function validateMutation(params: BoardParams) {
	if (
		params.action === "create_channel" ||
		params.new_channel_name !== undefined
	) {
		const name = required(
			params.new_channel_name ?? params.channel_name,
			"channel_name",
		);
		if (
			!name ||
			!wellFormed(name) ||
			Buffer.byteLength(name) > 128 ||
			name.trim() !== name ||
			/\p{Cc}/u.test(name)
		)
			throw new Error(
				"Channel must be 1-128 UTF-8 bytes without edge whitespace/control characters",
			);
	}
	if (params.action === "post") {
		const text = required(params.text, "text");
		if (!text || !wellFormed(text) || Buffer.byteLength(text) > 65536)
			throw new Error("Post must be 1-65536 UTF-8 bytes");
	}
}

// ES2023 target lacks String.isWellFormed typings. A code-point iteration leaves
// only unpaired surrogates in this range, matching the source's native check.
function wellFormed(value: string): boolean {
	for (const character of value) {
		const point = character.codePointAt(0);
		if (point !== undefined && point >= 0xd800 && point <= 0xdfff) return false;
	}
	return true;
}
