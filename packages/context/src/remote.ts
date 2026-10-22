import type { Context } from "@earendil-works/chord";
import type { ConversationId, Storage } from "@earendil-works/pi-durable";
import { canReadContextTarget } from "../../../internal/context-visibility.ts";
import { targetConversationId } from "./tool-contract.ts";

/** Host-owned stable family identities. This read-only catalogue never grants visibility. */
export interface ContextRemoteCatalog {
	catalog(
		caller: ConversationId,
		context: Context,
	): Promise<{
		familyId: string;
		currentAgentName: string;
		agents: readonly { agentName: string; conversationId: ConversationId }[];
	}>;
}

export async function resolveContextTarget(
	remote: ContextRemoteCatalog | undefined,
	args: { target?: string | undefined; agent_name?: string | null | undefined },
	caller: ConversationId,
	context: Context,
): Promise<{
	target: ConversationId;
	familyTargets?: readonly ConversationId[];
}> {
	context.abortSignal?.throwIfAborted();
	if (!remote) {
		if (args.agent_name != null)
			throw new Error(
				"Agent names require a host-configured remote Context catalogue",
			);
		return { target: targetConversationId(args.target, caller) };
	}
	if (args.target !== undefined && args.agent_name != null)
		throw new Error("Supply target or agent_name, not both");
	const catalog = await readRemoteCatalog(remote, caller, context);
	if (args.target !== undefined) {
		const target = targetConversationId(args.target, caller);
		if (!catalog.agents.some((agent) => agent.conversationId === target))
			throw new Error("Target is not in the caller's remote Context family");
		return {
			target,
			familyTargets: catalog.agents.map((agent) => agent.conversationId),
		};
	}
	const target = catalog.agents.find(
		(agent) =>
			agent.agentName === (args.agent_name || catalog.currentAgentName),
	)?.conversationId;
	if (target === undefined)
		throw new Error("Agent is not in the caller's remote Context family");
	return {
		target,
		familyTargets: catalog.agents.map((agent) => agent.conversationId),
	};
}

async function readRemoteCatalog(
	remote: ContextRemoteCatalog,
	caller: ConversationId,
	context: Context,
) {
	const catalog = await remote.catalog(caller, context);
	context.abortSignal?.throwIfAborted();
	if (
		!catalog ||
		typeof catalog.familyId !== "string" ||
		!catalog.familyId ||
		typeof catalog.currentAgentName !== "string" ||
		!catalog.currentAgentName ||
		!Array.isArray(catalog.agents) ||
		catalog.agents.length > 10_000
	)
		throw new Error(
			"Remote Context catalogue is invalid or exceeds 10000 agents",
		);
	const names = new Map<string, ConversationId>();
	for (const agent of catalog.agents) {
		if (
			!agent ||
			typeof agent.agentName !== "string" ||
			!agent.agentName ||
			!Number.isSafeInteger(agent.conversationId) ||
			agent.conversationId <= 0 ||
			names.has(agent.agentName)
		)
			throw new Error(
				"Remote Context catalogue contains an invalid or duplicate agent",
			);
		names.set(agent.agentName, agent.conversationId);
	}
	if (names.get(catalog.currentAgentName) !== caller)
		throw new Error(
			"Remote Context catalogue does not bind the caller identity",
		);
	return catalog;
}

export async function remoteContextHelp(
	remote: ContextRemoteCatalog | undefined,
	caller: ConversationId,
	storage: Storage,
	context: Context,
) {
	if (!remote) return {};
	const catalog = await readRemoteCatalog(remote, caller, context);
	const agents = [];
	for (const agent of catalog.agents) {
		context.abortSignal?.throwIfAborted();
		if (
			agent.conversationId === caller ||
			(await canReadContextTarget(
				storage,
				caller,
				agent.conversationId,
				context,
			))
		)
			agents.push({
				agent_name: agent.agentName,
				target: String(agent.conversationId),
			});
	}
	return {
		remote: {
			family_id: catalog.familyId,
			current_agent_name: catalog.currentAgentName,
			agents,
		},
		agent_name:
			"Select an authorised agent from remote.agents; defaults to current_agent_name; write own",
	};
}
