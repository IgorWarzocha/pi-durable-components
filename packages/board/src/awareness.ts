import type {
	ConversationId,
	HookApi,
	SubmissionId,
	Tx,
} from "@earendil-works/pi-durable";
import { defineDoc, defineEntry, LiveDoc } from "@earendil-works/pi-durable";
import { boardAddresses } from "./membership.ts";
import { BoardCatalog, BoardIndex } from "./store-model.ts";

const BoardAwareness = defineDoc<{
	seen: Record<string, string[]>;
	prepared: { scope: string; input: SubmissionId } | null;
}>({
	kind: "howaboua.agents.board.awareness",
	version: 1,
	scope: "conversation",
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
	history: "latest",
	fork: "initial",
	initial: () => ({ seen: {}, prepared: null }),
});
const CatchupReceipt = defineDoc<{
	saved: {
		role?: "system";
		scope: string;
		input: SubmissionId;
		content: string;
		timestamp: number;
	} | null;
}>({
	kind: "howaboua.agents.board.catchup-receipt",
	version: 1,
	scope: "task",
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
	initial: () => ({ saved: null }),
});
const CatchupEntry = defineEntry("howaboua.board.catchup");

export async function markBoardSeen(
	tx: Tx,
	conversationId: ConversationId,
	boardId: string,
	ids: string[],
) {
	const agentName = (await boardAddresses(tx, conversationId))[boardId];
	if (agentName === undefined || ids.length === 0) return;
	const awareness = await tx.doc(BoardAwareness, conversationId);
	const scope = `${boardId}:${agentName}`;
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
	const addresses = Object.entries(
		await boardAddresses(tx, api.conversationId),
	).sort(([a], [b]) => a.localeCompare(b));
	if (addresses.length === 0) return undefined;
	const scope = JSON.stringify(addresses);
	const onlyAddress = addresses.length === 1 ? addresses[0] : undefined;
	// Bundled Board persisted this key. Honour an interrupted hook's delivery
	// beyond the request cutoff rather than treating its seen posts as delivered.
	const legacyScope =
		onlyAddress === undefined
			? undefined
			: `${onlyAddress[0]}:${onlyAddress[1]}`;
	const sameScope = (saved: string) => saved === scope || saved === legacyScope;
	const receipt = await tx.doc(CatchupReceipt, api.taskId);
	if (
		receipt.saved !== null &&
		sameScope(receipt.saved.scope) &&
		receipt.saved.input === input
	)
		return {
			// Older interrupted receipts were user messages. Preserve their recorded role.
			role: receipt.saved.role ?? ("user" as const),
			content: receipt.saved.content,
			timestamp: receipt.saved.timestamp,
		};
	const awareness = await tx.doc(BoardAwareness, api.conversationId);
	if (
		awareness.prepared !== null &&
		sameScope(awareness.prepared.scope) &&
		awareness.prepared.input === input
	)
		return undefined;
	awareness.prepared = { scope, input };
	const catalog = await tx.doc(BoardCatalog);
	const references: string[] = [];
	for (const [boardId, agentName] of addresses) {
		if (!catalog.boards.some((board) => board.board_id === boardId)) continue;
		const index = await tx.doc(BoardIndex, boardId, null);
		const address = `${boardId}:${agentName}`;
		const seen = new Set(awareness.seen[address] ?? []);
		const updates = index.posts
			.filter(
				(post) =>
					post.author !== agentName &&
					!seen.has(post.message_id) &&
					index.subscriptions.some(
						(subscription) =>
							subscription.agent === agentName &&
							subscription.enabled &&
							subscription.target ===
								(post.message_id === post.thread_id
									? `channel:${post.channel_name}`
									: `thread:${post.thread_id}`),
					),
			)
			.slice(0, 50);
		if (updates.length === 0) continue;
		const threads = [...new Set(updates.map((post) => post.thread_id))];
		references.push(
			...threads.map(
				(thread_id) =>
					`board ${JSON.stringify({ action: "read_thread", board_id: boardId, thread_id })}`,
			),
		);
		awareness.seen[address] = [
			...seen,
			...updates.map((post) => post.message_id),
		];
	}
	if (references.length === 0) return undefined;
	const delivery = {
		role: "system" as const,
		scope,
		input,
		content: `Unread board updates available; read if relevant to the current task: ${references.join("; ")}`,
		timestamp: Date.now(),
	};
	receipt.saved = delivery;
	await tx.appendEntry(CatchupEntry, api.conversationId, {
		model: [
			{
				role: delivery.role,
				content: delivery.content,
				timestamp: delivery.timestamp,
			},
		],
	});
	return {
		role: delivery.role,
		content: delivery.content,
		timestamp: delivery.timestamp,
	};
}
