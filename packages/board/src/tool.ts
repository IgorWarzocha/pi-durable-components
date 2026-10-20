import {
	defineTool,
	type Harness,
	type JsonObject,
	type Storage,
	type TaskId,
} from "@earendil-works/pi-durable";
import { markBoardSeen } from "./awareness.ts";
import { BoardParameters, MUTATIONS, parseBoardRequest } from "./contract.ts";
import { BoardFamilies } from "./family-policy.ts";
import { boardScope, changeMembership } from "./membership.ts";
import { queueBoardNotices } from "./notices.ts";
import { serializeBoardResult } from "./response.ts";
import { executeBoard } from "./store.ts";
import { ThreadStates } from "./store-model.ts";
import { createSummaryTask, scheduleSummary } from "./summarizer.ts";

export function createBoardTool(
	requireBinding: () => { harness: Harness; storage: Storage },
	summaryTask: ReturnType<typeof createSummaryTask> | undefined,
	summaryPolicy: JsonObject,
) {
	const tool = defineTool({
		name: "board",
		description: "Shared discussion archive, not task assignment",
		parameters: BoardParameters,
		replay: "safe",
		executionMode: "sequential",
		outputLimits: { maxBytes: 8000, maxLines: Number.MAX_SAFE_INTEGER },
		execute: async (input, api, context) => {
			const args = parseBoardRequest(input);
			if (args.action === "attach" || args.action === "detach") {
				const value = await changeMembership(args, api, context);
				return {
					output: [{ type: "text", text: serializeBoardResult(value) }],
					details: value,
				};
			}
			if (args.action === "post" || args.action === "set_status")
				requireBinding();
			let cancel: TaskId | undefined;
			const agent = await api.agent(context);
			const ownerFolder = api.env?.cwd ?? agent.cwd ?? "";
			const value = await api.commit(async (tx) => {
				const scope = await boardScope(
					tx,
					api.conversationId,
					ownerFolder,
					MUTATIONS.has(args.action) ? args.board_id : undefined,
				);
				const result = await executeBoard(tx, scope, args, api.taskId);
				if (args.action === "read_post" || args.action === "read_thread") {
					const posts =
						args.action === "read_post"
							? [result.value]
							: [
									result.value["root_post"],
									...(Array.isArray(result.value["results"])
										? result.value["results"]
										: []),
								];
					const ids = posts.flatMap((post) =>
						post !== null &&
						typeof post === "object" &&
						!Array.isArray(post) &&
						typeof post["message_id"] === "string"
							? [post["message_id"]]
							: [],
					);
					await markBoardSeen(
						tx,
						api.conversationId,
						args.board_id ?? scope.boardId,
						ids,
					);
				}
				if (result.notice !== undefined) {
					if (args.action === "set_status") {
						const state = (await tx.doc(ThreadStates, scope.boardId, null))
							.threads[args.thread_id!];
						if (!state) throw new Error("Missing thread status");
						cancel = state.task_id ?? undefined;
						if (args.status !== "open" && summaryTask) {
							await scheduleSummary(
								tx,
								summaryTask,
								scope.boardId,
								args.thread_id!,
								scope.rootConversationId,
								`close:${state.status_message_id}`,
							);
						} else state.task_id = null;
					}
					const targets = result.recipients.flatMap((agentName) => {
						const conversationId = scope.members[agentName];
						return conversationId === undefined ||
							conversationId === api.conversationId
							? []
							: [{ conversationId, agentName }];
					});
					await queueBoardNotices(
						tx,
						targets,
						result.notice,
						`agents:board:${api.taskId}`,
						scope.boardId,
					);
				}
				return args.action === "help"
					? {
							...result.value,
							enabled: true,
							summarization: summaryPolicy,
							board_id: scope.boardId,
							agent_name: scope.agentName,
							can_manage_threads: scope.canManageThreads,
							participation: Object.entries(
								(await tx.doc(BoardFamilies)).families,
							).flatMap(([board_id, family]) => {
								const agent_name =
									family.participants[String(api.conversationId)];
								return agent_name === undefined
									? []
									: [{ board_id, agent_name }];
							}),
						}
					: result.value;
			}, context);
			if (cancel !== undefined)
				await requireBinding().harness.abortTask(cancel, context);
			return {
				output: [{ type: "text", text: serializeBoardResult(value) }],
				details: value,
			};
		},
	});
	return { ...tool, executionHints: { discovery: "help" as const } };
}
