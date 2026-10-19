import type { Context } from "@earendil-works/chord";
import type {
	ConversationId,
	Harness,
	Storage,
	Tx,
} from "@earendil-works/pi-durable";
import { defineExtension } from "@earendil-works/pi-durable";
import { boardScope } from "./membership.ts";
import { createBoardNoticeHooks } from "./notice-hooks.ts";
import { BoardCatalog, BoardIndex, findRoot } from "./store-model.ts";
import {
	type BoardSummaryOptions,
	createSummaryTask,
	LUNA_SUMMARY_MODEL,
	scheduleSummary,
} from "./summarizer.ts";
import { createBoardTool } from "./tool.ts";

export {
	readSavedThreads,
	type SavedPost,
	type SavedThread,
} from "./saved-threads.ts";

export type { BoardSummaryOptions } from "./summarizer.ts";
export { LUNA_SUMMARY_MODEL } from "./summarizer.ts";

/** Install before opening and bind before scheduling board posts or notice delivery. */
export function createBoard(
	options: { summary?: BoardSummaryOptions | false } = {},
) {
	let host: { harness: Harness; storage: Storage } | undefined;
	const binding = () => {
		if (host === undefined)
			throw new Error(
				"Bind the Board component before posting or delivering notices",
			);
		return host;
	};
	const summaryTask = createSummaryTask(
		options.summary === false ? {} : options.summary,
	);
	const tool = createBoardTool(
		binding,
		options.summary !== false ? summaryTask : undefined,
		options.summary === false
			? { enabled: false }
			: {
					enabled: true,
					model: options.summary?.model ?? LUNA_SUMMARY_MODEL,
					reasoning: options.summary?.reasoning ?? "high",
				},
	);
	const extension = defineExtension({
		name: "howaboua.board",
		tools: [tool],
		tasks: [summaryTask],
		hooks: createBoardNoticeHooks(binding, () => host),
	});
	return {
		extension,
		tool,
		bind(harness: Harness, storage: Storage) {
			if (
				host !== undefined &&
				(host.harness !== harness || host.storage !== storage)
			)
				throw new Error("Create a separate board component for each Harness");
			host = { harness, storage };
		},
		/** Release only after closing this Harness and its task invocations. */
		unbind(harness: Harness) {
			if (host?.harness === harness) host = undefined;
		},
		/** Explicit retry: reuse requestId to rejoin the original native task, including failures. */
		async summarize(
			conversationId: ConversationId,
			threadId: string,
			requestId: string,
			context: Context,
		) {
			if (options.summary === false)
				throw new Error("Board summarization is disabled by the host");
			const { harness } = binding();
			const result = await harness.commit(async (tx) => {
				const scope = await boardScope(tx, conversationId, "");
				if (scope.rootConversationId !== conversationId)
					throw new Error("Only the root conversation can summarize threads");
				const thread = threadId.toLowerCase();
				const index = await tx.doc(BoardIndex, scope.boardId, null);
				findRoot(index, thread);
				if (!index.has_thread_states)
					throw new Error(
						"Only completed or abandoned threads can be summarized",
					);
				return scheduleSummary(
					tx,
					summaryTask,
					scope.boardId,
					thread,
					conversationId,
					requestId,
				);
			}, context);
			if (result.previous !== undefined)
				await harness.abortTask(result.previous, context);
			return result.taskId;
		},
		async threadReference(
			tx: Tx,
			callerConversationId: ConversationId,
			threadId: string,
		): Promise<string> {
			const thread = threadId.toLowerCase();
			if (
				!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
					thread,
				)
			)
				throw new Error("board_thread_id must be a UUID");
			const scope = await boardScope(tx, callerConversationId, "");
			const catalog = await tx.doc(BoardCatalog);
			if (!catalog.boards.some((board) => board.board_id === scope.boardId))
				throw new Error("Thread not found in your current board");
			findRoot(await tx.doc(BoardIndex, scope.boardId, null), thread);
			return `Read the assigned board thread before working: board ${JSON.stringify({ action: "read_thread", thread_id: thread })}`;
		},
	};
}
