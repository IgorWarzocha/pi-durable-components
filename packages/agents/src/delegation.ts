import type { Context } from "@earendil-works/chord";
import type { ToolExecutionApi, Tx } from "@earendil-works/pi-durable";
import { configure, LiveDoc } from "@earendil-works/pi-durable";
import type { AgentsOptions, Request, WorkRequest } from "./contract.ts";
import { response } from "./contract.ts";
import type { Delegation, WorkResult } from "./state.ts";
import { Fleet, resolveTarget } from "./state.ts";
import { Anchor, Completion, Dispatch } from "./tasks.ts";

const background = {
	ownership: { kind: "conversation" },
	background: true,
} as const;
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

async function admitWork(
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

export async function send(
	args: Extract<Request, { action: "send" }>,
	api: ToolExecutionApi,
	context: Context,
) {
	if (!args.message.trim()) throw new Error("message must not be blank");
	const id = await api.commit((tx) => resolveTarget(tx, args.target), context);
	const recipient = await api.conversation(id, context);
	if (recipient === undefined) throw new Error(`Missing conversation ${id}`);
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

export async function delegate(
	args: WorkRequest,
	api: ToolExecutionApi,
	context: Context,
	profiles: AgentsOptions["profiles"],
) {
	const receipt = await api.commit(
		(tx) => admitWork(tx, args, api, profiles),
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
}
