import type {
	ConversationId,
	HookApi,
	SubmissionId,
	Tx,
} from "@earendil-works/pi-durable";
import { defineDoc, LiveDoc, UserEntry } from "@earendil-works/pi-durable";
import { BoardMembers } from "./membership.ts";
import { BoardCatalog, BoardIndex } from "./store-model.ts";

const BoardAwareness = defineDoc<{
	seen: Record<string, string[]>;
	prepared: { scope: string; input: SubmissionId } | null;
}>({
	kind: "howaboua.agents.board.awareness",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ seen: {}, prepared: null }),
});
const CatchupReceipt = defineDoc<{
	saved: {
		scope: string;
		input: SubmissionId;
		content: string;
		timestamp: number;
	} | null;
}>({
	kind: "howaboua.agents.board.catchup-receipt",
	version: 1,
	scope: "task",
	initial: () => ({ saved: null }),
});

export async function markBoardSeen(
	tx: Tx,
	conversationId: ConversationId,
	boardId: string,
	ids: string[],
) {
	const member = (await tx.doc(BoardMembers)).members[String(conversationId)];
	if (member === undefined || member.boardId !== boardId || ids.length === 0)
		return;
	const awareness = await tx.doc(BoardAwareness, conversationId);
	const scope = `${boardId}:${member.agentName}`;
	awareness.seen[scope] = [
		...new Set([...(awareness.seen[scope] ?? []), ...ids]),
	];
}

/** Caller validates the active task before any entry write in this transaction. */
export async function prepareBoardCatchup(
	tx: Tx,
	api: Pick<HookApi, "conversationId" | "taskId">,
) {
	const live = await tx.doc(LiveDoc, api.conversationId);
	const input = live.run?.inputs.at(-1);
	if (input === undefined || live.run?.taskId !== api.taskId) return undefined;
	const member = (await tx.doc(BoardMembers)).members[
		String(api.conversationId)
	];
	if (member === undefined) return undefined;
	const scope = `${member.boardId}:${member.agentName}`;
	const receipt = await tx.doc(CatchupReceipt, api.taskId);
	if (receipt.saved?.scope === scope && receipt.saved.input === input)
		return {
			content: receipt.saved.content,
			timestamp: receipt.saved.timestamp,
		};
	const awareness = await tx.doc(BoardAwareness, api.conversationId);
	if (awareness.prepared?.scope === scope && awareness.prepared.input === input)
		return undefined;
	awareness.prepared = { scope, input };
	const catalog = await tx.doc(BoardCatalog);
	if (!catalog.boards.some((board) => board.board_id === member.boardId))
		return undefined;
	const index = await tx.doc(BoardIndex, member.boardId, null);
	const seen = new Set(awareness.seen[scope] ?? []);
	const updates = index.posts
		.filter(
			(post) =>
				post.author !== member.agentName &&
				!seen.has(post.message_id) &&
				index.subscriptions.some(
					(subscription) =>
						subscription.agent === member.agentName &&
						subscription.enabled &&
						subscription.target ===
							(post.message_id === post.thread_id
								? `channel:${post.channel_name}`
								: `thread:${post.thread_id}`),
				),
		)
		.slice(0, 50);
	if (updates.length === 0) return undefined;
	const threads = [...new Set(updates.map((post) => post.thread_id))];
	const delivery = {
		scope,
		input,
		content: `Unread board updates available; read if relevant to the current task: ${threads.map((thread_id) => `board ${JSON.stringify({ action: "read_thread", thread_id })}`).join("; ")}`,
		timestamp: Date.now(),
	};
	awareness.seen[scope] = [...seen, ...updates.map((post) => post.message_id)];
	receipt.saved = delivery;
	await tx.appendEntry(UserEntry, api.conversationId, {
		model: [
			{
				role: "user",
				content: delivery.content,
				timestamp: delivery.timestamp,
			},
		],
	});
	return { content: delivery.content, timestamp: delivery.timestamp };
}
