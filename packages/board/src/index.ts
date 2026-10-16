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
import { createBoardTool } from "./tool.ts";

export {
	readSavedThreads,
	type SavedPost,
	type SavedThread,
} from "./saved-threads.ts";

/** Install before opening and bind before scheduling board posts or notice delivery. */
export function createBoard() {
	let host: { harness: Harness; storage: Storage } | undefined;
	const binding = () => {
		if (host === undefined)
			throw new Error(
				"Bind the Board component before posting or delivering notices",
			);
		return host;
	};
	const tool = createBoardTool(binding);
	const extension = defineExtension({
		name: "howaboua.board",
		tools: [tool],
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
