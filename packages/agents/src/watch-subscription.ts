import type { Context } from "@earendil-works/chord";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { InboxDoc, LiveDoc } from "@earendil-works/pi-durable";
import type { Request } from "./contract.ts";
import { response } from "./contract.ts";
import { Fleet, resolveTarget } from "./state.ts";
import type { AgentsBinding, createWatch } from "./watch.ts";
import { watchBaseline } from "./watch.ts";

const background = {
	ownership: { kind: "conversation" },
	background: true,
} as const;
export async function updateSubscription(
	args: Extract<Request, { action: "watch" | "unwatch" }>,
	api: ToolExecutionApi,
	context: Context,
	Watch: ReturnType<typeof createWatch>,
	binding: () => AgentsBinding,
) {
	const change = await api.commit(async (tx) => {
		const fleet = await tx.doc(Fleet);
		const old = fleet.changes[String(api.taskId)];
		if (old !== undefined) return { target: old.target, watched: old.watched };
		const id = await resolveTarget(tx, args.target);
		if (id === api.conversationId)
			throw new Error("Cannot watch the calling conversation");
		const key = `${api.conversationId}:${id}`;
		let watched = false;
		if (args.action === "watch") {
			watched = true;
			const previous = fleet.watches[key];
			const active =
				previous === undefined ? undefined : await tx.task(previous);
			if (active === undefined || active.state.status === "terminal") {
				await tx.doc(LiveDoc, id);
				await tx.doc(InboxDoc, id);
				// Membership and its input boundary are decided on the same Session line.
				const position = await watchBaseline(binding().storage, id, context);
				fleet.watches[key] = await tx.createTask(
					Watch,
					{ target: id, key, ...position },
					background,
				);
			}
		} else {
			watched = fleet.watches[key] !== undefined;
			delete fleet.watches[key];
		}
		const result = { target: id, watched };
		fleet.changes[String(api.taskId)] = result;
		return result;
	}, context);
	return response({
		target: String(change.target),
		[args.action === "watch" ? "watched" : "unwatched"]: change.watched,
	});
}
