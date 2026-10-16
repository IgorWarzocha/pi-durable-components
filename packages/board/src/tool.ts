import { defineTool } from "@earendil-works/pi-durable";
import { markBoardSeen } from "./awareness.ts";
import { BoardParameters, parseBoardRequest } from "./contract.ts";
import { boardScope, changeMembership } from "./membership.ts";
import { queueBoardNotices } from "./notices.ts";
import { serializeBoardResult } from "./response.ts";
import { executeBoard } from "./store.ts";

export function createBoardTool(requireBinding: () => unknown) {
	return defineTool({
		name: "board",
		description:
			"Shared discussion archive, not task assignment; call help first",
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
			if (args.action === "post") requireBinding();
			const agent = await api.agent(context);
			const ownerFolder = api.env?.cwd ?? agent.cwd ?? "";
			const value = await api.commit(async (tx) => {
				const scope = await boardScope(tx, api.conversationId, ownerFolder);
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
							board_id: scope.boardId,
							agent_name: scope.agentName,
						}
					: result.value;
			}, context);
			return {
				output: [{ type: "text", text: serializeBoardResult(value) }],
				details: value,
			};
		},
	});
}
