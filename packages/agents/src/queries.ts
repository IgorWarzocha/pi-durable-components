import type { Context } from "@earendil-works/chord";
import type { JsonObject, ToolExecutionApi } from "@earendil-works/pi-durable";
import { LiveDoc } from "@earendil-works/pi-durable";
import type { Request } from "./contract.ts";
import { response } from "./contract.ts";
import { Fleet } from "./state.ts";

export async function discoverAgents(
	args: Extract<Request, { action: "find" | "list" }>,
	api: ToolExecutionApi,
	context: Context,
) {
	const fleet = await api.snapshot(Fleet, context);
	const records = Object.values(fleet?.agents ?? {});
	const found: JsonObject[] = [];
	for (const agent of records) {
		const live = await api.snapshot(LiveDoc, agent.target, context);
		const status = live?.run === undefined ? "idle" : "working";
		if (args.action === "find") {
			if (args.status !== undefined && args.status !== status) continue;
			const query =
				args.query === undefined ? undefined : normalize(args.query);
			if (
				query !== undefined &&
				![agent.name, agent.label, agent.profile, String(agent.target)].some(
					(value) => normalize(value).includes(query),
				)
			)
				continue;
		}
		const watchId = fleet?.watches[`${api.conversationId}:${agent.target}`];
		const watcher =
			watchId === undefined ? undefined : await api.getTask(watchId, context);
		found.push({
			...agent,
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

function normalize(value: string): string {
	return value
		.toLowerCase()
		.replace(/[-_\s]+/g, " ")
		.trim();
}
