import { defineTool } from "@earendil-works/pi-durable";
import { BoardParameters, parseBoardRequest } from "./contract.ts";
import { boardScope } from "./membership.ts";
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
			if (args.action === "post") requireBinding();
			const agent = await api.agent(context);
			const ownerFolder = api.env?.cwd ?? agent.cwd ?? "";
			const value = await api.commit(async (tx) => {
				const scope = await boardScope(tx, api.conversationId, ownerFolder);
				const result = await executeBoard(tx, scope, args, api.taskId);
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
				content: [{ type: "text", text: serializeBoardResult(value) }],
				details: value,
			};
		},
	});
}
