import { randomUUID } from "node:crypto";
import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import { defineDocFamily, LiveDoc } from "@earendil-works/pi-durable";
import { agentPath } from "./contract.ts";
import { BoardFamilies } from "./family-policy.ts";
import { BoardMembers, boardScope } from "./membership.ts";
import { queueBoardNotices } from "./notices.ts";
import { executeBoard } from "./store.ts";
import {
	BoardCatalog,
	BoardIndex,
	compareText,
	findRoot,
	PostText,
	ThreadStates,
	textKey,
} from "./store-model.ts";

export type BoardFamily = {
	boardId: string;
	anchorConversationId: ConversationId;
	residentConversationId: ConversationId | null;
};
export type BoardEnrolment = {
	conversationId: ConversationId;
	anchorConversationId: ConversationId;
};
export type BoardResidentDesignation = {
	anchorConversationId: ConversationId;
	conversationId: ConversationId | null;
};
export type BoardParticipation = BoardEnrolment & { agentName: string };
export type BoardCanonicalThread = {
	conversationId: ConversationId;
	key: string;
	channel: string;
	text: string;
};
export type BoardThreadReference = { boardId: string; threadId: string };
export type BoardThread = BoardThreadReference & {
	title: string;
	status: "open" | "completed" | "abandoned";
	updatedAt: string;
};
export type BoardThreadQuery = {
	status?: BoardThread["status"];
	order?: "oldest" | "recent";
	limit?: number;
};
export type BoardThreadPage = { threads: BoardThread[]; truncated: boolean };
export type BoardPost = {
	conversationId: ConversationId;
	threadId: string;
	text: string;
	requestId: string;
};
export type BoardPosted = BoardThreadReference & { messageId: string };
const HostPostReceipt = defineDocFamily<
	{
		saved: { request: string; result: BoardPosted } | null;
	},
	null
>({
	kind: "howaboua.board.host-post",
	version: 1,
	scope: "session",
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
	family: true,
	initial: () => ({ saved: null }),
});

/** Resolves the actual saved family, never history order or fork ancestry. */
export async function family(
	tx: Tx,
	conversationId: ConversationId,
): Promise<BoardFamily> {
	if ((await tx.conversation(conversationId)) === undefined)
		throw new Error(`No conversation ${conversationId}`);
	const scope = await boardScope(tx, conversationId, "");
	if ((await tx.conversation(scope.rootConversationId)) === undefined)
		throw new Error(
			`Missing Board family anchor ${scope.rootConversationId}; recover it before enrolling conversations`,
		);
	const policy = (await tx.doc(BoardFamilies)).families[scope.boardId];
	return {
		boardId: scope.boardId,
		anchorConversationId: scope.rootConversationId,
		residentConversationId:
			policy === undefined
				? scope.rootConversationId
				: policy.residentConversationId,
	};
}

async function anchored(tx: Tx, anchor: ConversationId) {
	const resolved = await family(tx, anchor);
	if (resolved.anchorConversationId !== anchor)
		throw new Error(
			"anchorConversationId must be the saved Board family anchor",
		);
	return resolved;
}

async function policy(tx: Tx, anchor: ConversationId) {
	const resolved = await anchored(tx, anchor);
	const policies = await tx.doc(BoardFamilies);
	policies.families[resolved.boardId] ??= {
		anchorConversationId: anchor,
		residentConversationId: anchor,
		participants: {},
		threads: {},
	};
	return { resolved, value: policies.families[resolved.boardId]! };
}

/** Enrol an idle independent leaf; existing transcripts and the previous Board remain intact. */
export async function enrol(
	tx: Tx,
	input: BoardEnrolment,
): Promise<BoardFamily> {
	const target = await family(tx, input.conversationId);
	const anchor = await anchored(tx, input.anchorConversationId);
	if (target.boardId === anchor.boardId) return target;
	const directory = await tx.doc(BoardMembers);
	const current = directory.members[String(input.conversationId)];
	if (!current) throw new Error("Missing Board membership");
	if ((await tx.doc(LiveDoc, input.conversationId)).run !== undefined)
		throw new Error("Enrol a conversation before its first input, while idle");
	if (
		current.parent !== undefined ||
		Object.values(directory.members).some(
			(member) => member.parent === input.conversationId,
		)
	)
		throw new Error(
			"Only an independent Board leaf can be enrolled; native workers inherit their owner's family",
		);
	const oldPolicy = (await tx.doc(BoardFamilies)).families[current.boardId];
	if (oldPolicy?.residentConversationId === input.conversationId)
		throw new Error(
			"Release resident authority before enrolling in another family",
		);
	directory.members[String(input.conversationId)] = {
		boardId: anchor.boardId,
		rootConversationId: anchor.anchorConversationId,
		agentName: `/root/agent-${input.conversationId}-${randomUUID()}`,
		parent: anchor.anchorConversationId,
		previous: {
			boardId: current.boardId,
			rootConversationId: current.rootConversationId,
			agentName: current.agentName,
		},
	};
	return family(tx, input.conversationId);
}

/** This host-only authority is not conferred by membership, native ownership or write grants. */
export async function designateResident(
	tx: Tx,
	input: BoardResidentDesignation,
): Promise<BoardFamily> {
	const { resolved, value } = await policy(tx, input.anchorConversationId);
	if (
		input.conversationId !== null &&
		(await family(tx, input.conversationId)).boardId !== resolved.boardId
	)
		throw new Error(
			"Enrol the resident in its family before granting lifecycle authority",
		);
	value.residentConversationId = input.conversationId;
	return { ...resolved, residentConversationId: input.conversationId };
}

export async function grantParticipation(
	tx: Tx,
	input: BoardParticipation,
): Promise<BoardFamily> {
	const own = await family(tx, input.conversationId);
	const { resolved, value } = await policy(tx, input.anchorConversationId);
	if (own.boardId === resolved.boardId)
		throw new Error("Conversation already belongs to this local family");
	const name = agentPath(input.agentName, "/root");
	if (name === "/root")
		throw new Error("Participants cannot use the resident's root address");
	const directory = await tx.doc(BoardMembers);
	if (
		Object.values(directory.members).some(
			(member) =>
				member.boardId === resolved.boardId && member.agentName === name,
		) ||
		Object.entries(value.participants).some(
			([id, other]) => id !== String(input.conversationId) && other === name,
		)
	)
		throw new Error("Board participant address is already in use");
	const previous = value.participants[String(input.conversationId)];
	if (previous !== undefined && previous !== name)
		throw new Error(
			"Revoke the previous participation address before changing it",
		);
	value.participants[String(input.conversationId)] = name;
	return resolved;
}

export async function revokeParticipation(
	tx: Tx,
	input: BoardEnrolment,
): Promise<void> {
	const { value } = await policy(tx, input.anchorConversationId);
	const name = value.participants[String(input.conversationId)];
	if (name === undefined) return;
	delete value.participants[String(input.conversationId)];
	const board = (await family(tx, input.anchorConversationId)).boardId;
	if (
		(await tx.doc(BoardCatalog)).boards.some((item) => item.board_id === board)
	) {
		const index = await tx.doc(BoardIndex, board, null);
		for (const subscription of index.subscriptions)
			if (subscription.agent === name) subscription.enabled = false;
	}
}

/** Host-owned canonical references are created with their post in the same transaction. */
export async function ensureThread(
	tx: Tx,
	input: BoardCanonicalThread,
): Promise<BoardThreadReference> {
	if (!input.key || input.key.length > 128)
		throw new Error("Canonical thread key must be 1-128 characters");
	const scope = await boardScope(tx, input.conversationId, "");
	const { value } = await policy(tx, scope.rootConversationId);
	const present = value.threads[input.key];
	if (present !== undefined) {
		findRoot(await tx.doc(BoardIndex, scope.boardId, null), present);
		return { boardId: scope.boardId, threadId: present };
	}
	if (!scope.canManageThreads)
		throw new Error(
			"Only the designated resident can create a canonical thread",
		);
	const catalog = await tx.doc(BoardCatalog);
	const exists = catalog.boards.some((item) => item.board_id === scope.boardId);
	const index = exists
		? await tx.doc(BoardIndex, scope.boardId, null)
		: undefined;
	// executeBoard's receipt is task-scoped; this host transaction has no task. Its
	// canonical-reference write supplies idempotency, using the same publish logic.
	const result = await executeBoard(
		tx,
		scope,
		{
			action: "post",
			...(index?.channels.some((channel) => channel.name === input.channel)
				? { channel_name: input.channel }
				: { new_channel_name: input.channel }),
			text: input.text,
		},
		undefined,
	);
	const threadId = result.value["thread_id"];
	if (typeof threadId !== "string")
		throw new Error("Board did not create a thread");
	value.threads[input.key] = threadId;
	if (result.notice !== undefined)
		await queueBoardNotices(
			tx,
			result.recipients.flatMap((agentName) => {
				const conversationId = scope.members[agentName];
				return conversationId === undefined ||
					conversationId === input.conversationId
					? []
					: [{ conversationId, agentName }];
			}),
			result.notice,
			`board:canonical:${scope.boardId}:${input.key}`,
			scope.boardId,
		);
	return { boardId: scope.boardId, threadId };
}

/** Retry-safe host posts use the same validation, publication and passive notices as the tool. */
export async function post(tx: Tx, input: BoardPost): Promise<BoardPosted> {
	if (!input.requestId.trim() || Buffer.byteLength(input.requestId) > 1024)
		throw new Error("Board post requestId must be 1-1024 UTF-8 bytes");
	const scope = await boardScope(tx, input.conversationId, "");
	const receipt = await tx.doc(
		HostPostReceipt,
		`${scope.boardId}:${input.requestId}`,
		null,
	);
	const request = JSON.stringify(input);
	if (receipt.saved !== null) {
		if (receipt.saved.request !== request)
			throw new Error("Board post requestId reused with different arguments");
		return { ...receipt.saved.result };
	}
	const result = await executeBoard(
		tx,
		scope,
		{ action: "post", thread_id: input.threadId, text: input.text },
		undefined,
	);
	const messageId = result.value["message_id"];
	const threadId = result.value["thread_id"];
	if (typeof messageId !== "string" || typeof threadId !== "string")
		throw new Error("Board did not publish a post");
	if (result.notice !== undefined)
		await queueBoardNotices(
			tx,
			result.recipients.flatMap((agentName) => {
				const conversationId = scope.members[agentName];
				return conversationId === undefined ||
					conversationId === input.conversationId
					? []
					: [{ conversationId, agentName }];
			}),
			result.notice,
			`board:host-post:${scope.boardId}:${input.requestId}`,
			scope.boardId,
		);
	const posted = { boardId: scope.boardId, threadId, messageId };
	receipt.saved = { request, result: posted };
	return { ...posted };
}

/** A bounded projection of feature-native thread references, not a second Board store. */
export async function threads(
	tx: Tx,
	conversationId: ConversationId,
	query: BoardThreadQuery = {},
): Promise<BoardThreadPage> {
	const limit = query.limit ?? 50;
	if (!Number.isInteger(limit) || limit < 1 || limit > 50)
		throw new Error("Board thread limit must be an integer from 1 to 50");
	if (
		query.order !== undefined &&
		query.order !== "oldest" &&
		query.order !== "recent"
	)
		throw new Error("Board thread order must be oldest or recent");
	if (
		query.status !== undefined &&
		!["open", "completed", "abandoned"].includes(query.status)
	)
		throw new Error("Invalid Board thread status");
	const { boardId } = await family(tx, conversationId);
	if (
		!(await tx.doc(BoardCatalog)).boards.some(
			(board) => board.board_id === boardId,
		)
	)
		return { threads: [], truncated: false };
	const index = await tx.doc(BoardIndex, boardId, null);
	const states = index.has_thread_states
		? (await tx.doc(ThreadStates, boardId, null)).threads
		: {};
	const roots = index.posts.filter(
		(post) =>
			post.message_id === post.thread_id &&
			(query.status === undefined ||
				(states[post.thread_id]?.status ?? "open") === query.status),
	);
	const updated = new Map<string, string>();
	for (const post of index.posts)
		updated.set(
			post.thread_id,
			[updated.get(post.thread_id) ?? "", post.created_at].sort().at(-1)!,
		);
	const direction = query.order === "oldest" ? 1 : -1;
	roots.sort(
		(a, b) =>
			direction *
			(compareText(
				updated.get(a.thread_id) ?? a.created_at,
				updated.get(b.thread_id) ?? b.created_at,
			) || a.seq - b.seq),
	);
	const selected = await Promise.all(
		roots.slice(0, limit).map(async (post) => ({
			boardId,
			threadId: post.thread_id,
			title: Array.from(
				(await tx.doc(PostText, textKey(boardId, post.message_id), null)).text,
			)
				.slice(0, 180)
				.join(""),
			status: states[post.thread_id]?.status ?? ("open" as const),
			updatedAt: updated.get(post.thread_id) ?? post.created_at,
		})),
	);
	return { threads: selected, truncated: roots.length > limit };
}
