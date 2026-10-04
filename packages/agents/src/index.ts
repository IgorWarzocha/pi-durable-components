import type { Context } from "@earendil-works/chord";
import type { Static } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import type {
	AgentChange,
	Cursor,
	EntryId,
	EntryRecord,
	Harness,
	JsonObject,
	Storage,
	ToolExecutionApi,
	Tx,
} from "@earendil-works/pi-durable";
import {
	configure,
	defineExtension,
	defineTool,
	InboxDoc,
	LiveDoc,
} from "@earendil-works/pi-durable";
import type { Delegation, WorkResult } from "./state.ts";
import { Fleet, resolveTarget, textOf } from "./state.ts";
import { Anchor, Completion, Dispatch } from "./tasks.ts";
import type { AgentsBinding } from "./watch.ts";
import { createWatch, watchBaseline } from "./watch.ts";

export type AgentProfile = {
	description: string;
	agent: AgentChange;
	/** Overrides the call's blocking choice, as in the source profile policy. */
	blocking?: boolean;
};
export type AgentsOptions = {
	profiles: Readonly<Record<string, AgentProfile>>;
};

const target = Type.String({ minLength: 1 });
const message = Type.String({ minLength: 1 });
const action = <T extends string>(name: T) => ({ action: Type.Literal(name) });
const object = { additionalProperties: false };
export const AgentsParameters = Type.Union([
	Type.Object(action("help"), object),
	Type.Object(
		{ ...action("list"), offset: Type.Optional(Type.Integer({ minimum: 0 })) },
		object,
	),
	Type.Object(
		{
			...action("find"),
			query: Type.Optional(Type.String()),
			status: Type.Optional(
				Type.Union([Type.Literal("idle"), Type.Literal("working")]),
			),
			offset: Type.Optional(Type.Integer({ minimum: 0 })),
		},
		object,
	),
	Type.Object(
		{
			...action("spawn"),
			agent_type: target,
			label: target,
			message,
			name: Type.Optional(target),
			cwd: Type.Optional(target),
			blocking: Type.Optional(
				Type.Boolean({
					description:
						"False while continuing other work; completion arrives automatically",
				}),
			),
		},
		object,
	),
	Type.Object({ ...action("send"), target, message }, object),
	Type.Object(
		{
			...action("assign"),
			target,
			message,
			blocking: Type.Optional(Type.Boolean()),
		},
		object,
	),
	Type.Object(
		{
			...action("read"),
			target,
			source: Type.Optional(
				Type.Union([Type.Literal("latest"), Type.Literal("recent")]),
			),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
			before: Type.Optional(Type.Integer({ minimum: 1 })),
			entry: Type.Optional(Type.Integer({ minimum: 1 })),
			offset: Type.Optional(Type.Integer({ minimum: 0 })),
		},
		object,
	),
	Type.Object({ ...action("watch"), target }, object),
	Type.Object({ ...action("unwatch"), target }, object),
]);
type Request = Static<typeof AgentsParameters>;
type WorkRequest = Extract<Request, { action: "spawn" | "assign" }>;
const background = {
	ownership: { kind: "conversation" },
	background: true,
} as const;
const response = (details: JsonObject, isError = false) => ({
	content: [{ type: "text" as const, text: JSON.stringify(details) }],
	details,
	isError,
});

function allocateName(
	txNames: readonly string[],
	label: string,
	explicit?: string,
): string {
	if (explicit !== undefined) {
		if (!explicit.trim()) throw new Error("name must not be blank");
		if (/^\d+$/.test(explicit))
			throw new Error("Numeric names are reserved for stable conversation IDs");
		if (txNames.includes(explicit))
			throw new Error(`Agent name ${explicit} already exists`);
		return explicit;
	}
	const slug = label
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	const base =
		(/^[a-z]/.test(slug) ? slug : `agent-${slug}`)
			.slice(0, 32)
			.replace(/-+$/g, "") || "agent";
	let name = base;
	for (let suffix = 2; txNames.includes(name); suffix++) {
		if (suffix >= 10_000)
			throw new Error(
				`Could not allocate an agent name for ${JSON.stringify(label)}`,
			);
		const tail = `-${suffix}`;
		name = `${base.slice(0, 32 - tail.length).replace(/-+$/g, "")}${tail}`;
	}
	return name;
}

async function delegate(
	tx: Tx,
	args: WorkRequest,
	api: ToolExecutionApi,
	profiles: AgentsOptions["profiles"],
): Promise<Delegation> {
	const fleet = await tx.doc(Fleet);
	const existing = fleet.delegations[String(api.taskId)];
	// Transaction drafts cannot escape their overlay, including on the recovery path.
	if (existing !== undefined)
		return {
			target: existing.target,
			name: existing.name,
			blocking: existing.blocking,
			dispatch: existing.dispatch,
			reporter: existing.reporter,
		};
	if (!args.message.trim()) throw new Error("message must not be blank");
	let targetId;
	let name;
	let blocking = args.blocking ?? true;
	if (args.action === "spawn") {
		const profile = Object.hasOwn(profiles, args.agent_type)
			? profiles[args.agent_type]
			: undefined;
		if (profile === undefined)
			throw new Error(`Unknown agent_type ${args.agent_type}; call help`);
		if (
			args.label.trim().split(/\s+/).length < 2 ||
			args.label.trim().split(/\s+/).length > 3
		) {
			throw new Error("label must contain 2 or 3 words");
		}
		blocking = profile.blocking ?? blocking;
		name = allocateName(
			Object.values(fleet.agents).map((item) => item.name),
			args.label,
			args.name,
		);
		const anchor = await tx.createTask(Anchor, null, background);
		const child = await tx.createConversation({
			ownership: { kind: "task", taskId: anchor },
		});
		targetId = child.id;
		await configure(tx, child.id, {
			...profile.agent,
			...(args.cwd === undefined ? {} : { cwd: args.cwd }),
		});
		// Ensure the explicit-watch event source exists even before the child's first run.
		await tx.doc(LiveDoc, child.id);
		fleet.agents[String(child.id)] = {
			target: child.id,
			name,
			label: args.label,
			profile: args.agent_type,
			controller: api.conversationId,
		};
	} else {
		targetId = await resolveTarget(tx, args.target);
		name = fleet.agents[String(targetId)]?.name ?? String(targetId);
	}
	if (targetId === api.conversationId)
		throw new Error("Cannot delegate to the calling conversation; use send");
	const dispatch = await tx.createTask(
		Dispatch,
		{
			target: targetId,
			message: args.message,
			controller: api.conversationId,
		},
		background,
	);
	const reporter = await tx.createTask(
		Completion,
		{
			target: targetId,
			dispatch,
			caller: api.taskId,
			blocking,
		},
		background,
	);
	const receipt = { target: targetId, name, blocking, dispatch, reporter };
	fleet.delegations[String(api.taskId)] = receipt;
	return receipt;
}

async function discovery(
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

async function read(
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

async function membership(
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

/** Install before opening, bind the Harness and storage before scheduling, and select on controllers. */
export function createAgents(options: AgentsOptions) {
	let host: AgentsBinding | undefined;
	const binding = () => {
		if (host === undefined)
			throw new Error(
				"Persistent watches are unavailable. Delegation and message-only send remain available",
			);
		return host;
	};
	const Watch = createWatch(binding);
	const tool = defineTool({
		name: "agents",
		description: "Delegate to persistent agents; call help first",
		parameters: AgentsParameters,
		replay: "safe",
		executionMode: "sequential",
		// Delegation results retain full replies. Only read applies an intentional output bound.
		outputLimits: {
			maxBytes: Number.MAX_SAFE_INTEGER,
			maxLines: Number.MAX_SAFE_INTEGER,
		},
		execute: async (args, api, context) => {
			if (args.action === "help")
				return response({
					actions: {
						help: "",
						list: "offset?",
						find: "query? status? offset?",
						spawn: "agent_type label message name? cwd? blocking?",
						send: "target message",
						assign: "target message blocking?",
						read: "target source? limit? before? entry? offset?",
						watch: "target",
						unwatch: "target",
					},
					profiles: Object.fromEntries(
						Object.entries(options.profiles).map(([name, profile]) => [
							name,
							{
								description: profile.description,
								...(profile.blocking === undefined
									? {}
									: { blocking: profile.blocking }),
							},
						]),
					),
					rules: {
						target:
							"Use the conversation ID from spawn/find, or an exact unique name",
						blocking:
							"Defaults true; spawn profile policy overrides. False reports completion after you reply. No polling",
						send: "Admits a message, wakes idle recipients, steers active work. No wait or implicit watch",
						watch: "Persists until unwatch; delegation reports are task-scoped",
						read: "latest returns the newest assistant; recent returns a bounded transcript page. before continues older entries; entry + nextOffset retrieves truncated text",
					},
				});
			if (args.action === "list" || args.action === "find")
				return discovery(args, api, context);
			if (args.action === "read") return read(args, api, context);
			if (args.action === "watch" || args.action === "unwatch")
				return membership(args, api, context, Watch, binding);
			if (args.action === "send") {
				if (!args.message.trim()) throw new Error("message must not be blank");
				const id = await api.commit(
					(tx) => resolveTarget(tx, args.target),
					context,
				);
				const recipient = await api.conversation(id, context);
				if (recipient === undefined)
					throw new Error(`Missing conversation ${id}`);
				const submission = await recipient.submit(
					{
						type: "input",
						content: `[Message from conversation ${api.conversationId}]\n${args.message}`,
						whenBusy: "steer",
						requestId: `agents:send:${api.taskId}`,
					},
					context,
				);
				return response({
					sent: true,
					target: String(id),
					submission: submission.id,
				});
			}
			const receipt = await api.commit(
				(tx) => delegate(tx, args, api, options.profiles),
				context,
			);
			await api.details(
				{
					target: String(receipt.target),
					dispatch: receipt.dispatch,
					reporter: receipt.reporter,
				},
				context,
			);
			let result: WorkResult | undefined;
			if (receipt.blocking) {
				const task = await api.waitForTask(receipt.dispatch, context);
				result =
					task.state.outcome.status === "completed"
						? task.state.outcome.result
						: {
								target: receipt.target,
								status: "failed",
								reply: "",
								reason: task.state.outcome.status,
							};
			}
			return response(
				{
					[args.action === "spawn" ? "spawned" : "assigned"]: true,
					name: receipt.name,
					dispatch: receipt.dispatch,
					reporter: receipt.reporter,
					...(result ?? { status: "working" }),
					target: String(receipt.target),
				},
				result?.status === "failed",
			);
		},
	});
	const extension = defineExtension({
		name: "howaboua.agents",
		tools: [tool],
		tasks: [Anchor, Dispatch, Completion, Watch],
	});
	return {
		extension,
		tool,
		bind(harness: Harness, storage: Storage) {
			if (
				host !== undefined &&
				(host.harness !== harness || host.storage !== storage)
			) {
				throw new Error("Create a separate agents component for each Harness");
			}
			host = { harness, storage };
		},
	};
}
