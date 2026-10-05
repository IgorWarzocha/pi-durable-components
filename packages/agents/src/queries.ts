import type { Context } from "@earendil-works/chord";
import type {
	Cursor,
	EntryId,
	EntryRecord,
	JsonObject,
	ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { LiveDoc } from "@earendil-works/pi-durable";
import { BoardMembers } from "./board/membership.ts";
import type { Request } from "./contract.ts";
import { response } from "./contract.ts";
import { Fleet, resolveTarget, textOf } from "./state.ts";

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

export async function readAgent(
	args: Extract<Request, { action: "read" }>,
	api: ToolExecutionApi,
	context: Context,
) {
	if (args.offset !== undefined && args.entry === undefined)
		throw new Error("offset requires entry from a previous read");
	if (args.entry !== undefined && args.before !== undefined)
		throw new Error(
			"Use entry for text continuation or before for history, not both",
		);
	const id = await api.commit((tx) => resolveTarget(tx, args.target), context);
	const live = await api.snapshot(LiveDoc, id, context);
	return api.commit(async (tx) => {
		// The schema validates numeric bounds. The scan enforces visibility in this conversation.
		const query = {
			conversationId: id,
			...(args.before === undefined
				? {}
				: { maxEntryId: (args.before - 1) as EntryId }),
			...(args.entry === undefined
				? {}
				: {
						minEntryId: args.entry as EntryId,
						maxEntryId: args.entry as EntryId,
					}),
		};
		const source = args.source ?? "latest";
		let cursor: Cursor | undefined;
		let selected: readonly EntryRecord[] = [];
		do {
			const page = await tx.scanEntries(
				query,
				args.entry === undefined ? (args.limit ?? 40) : 1,
				cursor,
			);
			selected =
				source === "latest" && args.entry === undefined
					? page.items
							.filter((item) => item.kind === "pi.assistant")
							.slice(0, 1)
					: page.items;
			cursor = page.next;
		} while (
			source === "latest" &&
			selected.length === 0 &&
			cursor !== undefined
		);
		let budget = 36_000;
		const data = selected.map((item) => {
			const text = textOf(item.model);
			const offset = args.offset ?? 0;
			const part = text.slice(offset, offset + budget);
			budget -= part.length;
			const truncated = offset + part.length < text.length;
			return {
				id: item.id,
				kind: item.kind,
				text: part,
				truncated,
				...(truncated ? { nextOffset: offset + part.length } : {}),
			};
		});
		// latest's reply must not duplicate the same text in its continuation metadata.
		const outputEntries =
			source === "latest"
				? data.map(({ text: _text, ...entry }) => entry)
				: data;
		return response({
			target: String(id),
			status: live?.run === undefined ? "idle" : "working",
			entries: outputEntries,
			...(source === "latest" ? { reply: data[0]?.text ?? null } : {}),
			truncated: cursor !== undefined || data.some((entry) => entry.truncated),
			...(selected.length === 0
				? {}
				: { before: selected[selected.length - 1]?.id ?? 0 }),
		});
	}, context);
}
