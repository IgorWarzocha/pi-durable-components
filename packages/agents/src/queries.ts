import type { Context } from "@earendil-works/chord";
import type { JsonObject, ToolExecutionApi } from "@earendil-works/pi-durable";
import { LiveDoc } from "@earendil-works/pi-durable";
import { BoardMembers } from "./board/membership.ts";
import type { Request } from "./contract.ts";
import { response } from "./contract.ts";
import { Fleet } from "./state.ts";

export async function discoverAgents(
	args: Extract<Request, { action: "find" | "list" }>,
	api: ToolExecutionApi,
	context: Context,
) {
	const fleet = await api.snapshot(Fleet, context);
	const directory = await api.snapshot(BoardMembers, context);
	const records = Object.values(fleet?.agents ?? {});
	const found: JsonObject[] = [];
	for (const agent of records) {
		const live = await api.snapshot(LiveDoc, agent.target, context);
		const status = live?.run === undefined ? "idle" : "working";
		if (args.action === "find") {
			if (args.status !== undefined && args.status !== status) continue;
			if (
				args.query !== undefined &&
				!`${agent.name}\n${agent.label}\n${agent.profile}\n${agent.target}`
					.toLowerCase()
					.includes(args.query.toLowerCase())
			)
				continue;
		}
		const watchId = fleet?.watches[`${api.conversationId}:${agent.target}`];
		const watcher =
			watchId === undefined ? undefined : await api.getTask(watchId, context);
		const member = directory?.members[String(agent.target)];
		found.push({
			...agent,
			...(member === undefined ? {} : { boardAgent: member.agentName }),
			target: String(agent.target),
			status,
			...(live?.run === undefined ? {} : { run: live.run.taskId }),
			watched: watcher !== undefined && watcher.state.status !== "terminal",
		});
	}
	const offset = args.offset ?? 0;
	return response({
		agents: found.slice(offset, offset + 30),
		...(found.length > offset + 30 ? { nextOffset: offset + 30 } : {}),
	});
}
