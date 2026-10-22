import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import { LiveDoc } from "@earendil-works/pi-durable";
import { BoardFamilies } from "./family-policy.ts";
import { boardScope } from "./membership.ts";
import { BoardCatalog, BoardIndex, ThreadStates } from "./store-model.ts";

export type BoardThreadMerge = { threadId: string; intoThreadId: string };
export type BoardConsolidation = {
	conversationId: ConversationId;
	merges: BoardThreadMerge[];
	dryRun?: boolean;
};

/** Host-selected topic merges. The caller owns the short transaction and cancellation. */
export async function consolidate(tx: Tx, input: BoardConsolidation) {
	const scope = await boardScope(tx, input.conversationId, "");
	if (!scope.canManageThreads)
		throw new Error("Only the designated resident can consolidate threads");
	if ((await tx.doc(LiveDoc, input.conversationId)).run !== undefined)
		throw new Error(
			"Wait for this conversation to finish before consolidating",
		);
	if (
		!(await tx.doc(BoardCatalog)).boards.some(
			(board) => board.board_id === scope.boardId,
		)
	)
		throw new Error("This board has no archive to consolidate yet");
	const index = await tx.doc(BoardIndex, scope.boardId, null);
	const states = index.has_thread_states
		? (await tx.doc(ThreadStates, scope.boardId, null)).threads
		: {};
	// Simulate the entire ordered batch before touching the tracked archive. Dry runs
	// and commits therefore use identical checks, including earlier merges in a batch.
	const posts = index.posts.map((post) => ({ ...post }));
	let subscriptions = index.subscriptions.map((item) => ({ ...item }));
	const counts = () => {
		const sizes = new Map<string, number>();
		for (const post of posts)
			sizes.set(post.thread_id, (sizes.get(post.thread_id) ?? 0) + 1);
		return {
			threads: sizes.size,
			singletons: [...sizes.values()].filter((size) => size === 1).length,
		};
	};
	const before = counts();
	const merged: BoardThreadMerge[] = [];
	const skipped: (BoardThreadMerge & { reason: string })[] = [];
	for (const merge of input.merges) {
		const { threadId, intoThreadId } = merge;
		const source = posts.find(
			(post) => post.message_id === threadId && post.thread_id === threadId,
		);
		const target = posts.find(
			(post) =>
				post.message_id === intoThreadId && post.thread_id === intoThreadId,
		);
		let reason: string | undefined;
		if (!source || !target || threadId === intoThreadId)
			reason = "Distinct current thread roots are required";
		else if (source.channel_name !== target.channel_name)
			reason = "Threads must belong to the same channel";
		else if (posts.filter((post) => post.thread_id === threadId).length !== 1)
			reason = "Source thread is no longer a singleton";
		else if (
			[threadId, intoThreadId].some((id) => {
				const state = states[id];
				return (
					state !== undefined &&
					(state.status !== "open" ||
						state.summary !== null ||
						state.task_id !== null)
				);
			})
		)
			reason = "Closed, summarised or summarising threads cannot be merged";
		const oldTarget = `thread:${threadId}`;
		const newTarget = `thread:${intoThreadId}`;
		const moving = subscriptions.filter((item) => item.target === oldTarget);
		if (
			!reason &&
			moving.some((item) =>
				subscriptions.some(
					(other) =>
						other.target === newTarget &&
						other.agent === item.agent &&
						other.enabled !== item.enabled,
				),
			)
		)
			reason = "Subscription preferences conflict";
		if (reason !== undefined || source === undefined) {
			skipped.push({ ...merge, reason: reason ?? "Source thread not found" });
			continue;
		}
		source.thread_id = intoThreadId;
		subscriptions = subscriptions.filter((item) => item.target !== oldTarget);
		for (const item of moving)
			if (
				!subscriptions.some(
					(other) => other.target === newTarget && other.agent === item.agent,
				)
			)
				subscriptions.push({ ...item, target: newTarget });
		merged.push({ ...merge });
	}
	if (input.dryRun !== true && merged.length > 0) {
		index.posts = posts;
		index.subscriptions = subscriptions;
		// Canonical host keys must resolve to live roots after the same commit.
		const policy = (await tx.doc(BoardFamilies)).families[scope.boardId];
		if (policy !== undefined)
			for (const merge of merged)
				for (const [key, id] of Object.entries(policy.threads))
					if (id === merge.threadId) policy.threads[key] = merge.intoThreadId;
	}
	return {
		boardId: scope.boardId,
		dryRun: input.dryRun === true,
		before,
		after: counts(),
		merged,
		skipped,
	};
}
