// Adapted from Pi Stuff e4aa5bb4, Copyright (c) 2026 Igor Warzocha, MIT.
import type { Context } from "@earendil-works/chord";
import type { Models, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	type Agent,
	AgentDoc,
	type ConversationId,
	type ModelRef,
	type Tx,
} from "@earendil-works/pi-durable";

/** User-owned role preferences. The host owns configuration paths and access policy. */
export type ContextModelRole = {
	id: string;
	description: string;
	provider: string;
	model: string;
	reasoning: ModelThinkingLevel;
};
/** Read-only catalogue. Preparation snapshots definitions before awaiting provider access. */
export type ContextModelRoles = (
	conversationId: ConversationId,
	context: Context,
) => readonly ContextModelRole[] | Promise<readonly ContextModelRole[]>;

export type PreparedRole = {
	id: string;
	model: ModelRef;
	thinkingLevel: ModelThinkingLevel;
	source: { model: ModelRef | null; thinkingLevel: ModelThinkingLevel };
};

async function readRoles(
	catalog: ContextModelRoles | undefined,
	id: ConversationId,
	context: Context,
) {
	const roles = catalog ? await catalog(id, context) : [];
	const ids = new Set<string>();
	if (!Array.isArray(roles))
		throw new Error("Model roles configuration must contain a roles array");
	for (const role of roles) {
		if (
			!role ||
			typeof role.id !== "string" ||
			!/^[a-z][a-z0-9-]*$/.test(role.id) ||
			typeof role.description !== "string" ||
			!role.description.trim() ||
			typeof role.provider !== "string" ||
			!role.provider.trim() ||
			typeof role.model !== "string" ||
			!role.model.trim() ||
			!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
				role.reasoning,
			) ||
			ids.has(role.id)
		)
			throw new Error(
				"Invalid or duplicate model role; ask the user to check model role configuration",
			);
		ids.add(role.id);
	}
	return roles.map(({ id, description, provider, model, reasoning }) => ({
		id,
		description,
		provider,
		model,
		reasoning,
	}));
}

export async function renderModelRoles(
	catalog: ContextModelRoles | undefined,
	id: ConversationId,
	context: Context,
) {
	let roles: readonly ContextModelRole[];
	try {
		roles = await readRoles(catalog, id, context);
	} catch {
		context.abortSignal?.throwIfAborted();
		return "Model roles are unavailable. Ask the user to check their configuration. Call new_context without role to keep the current model.";
	}
	if (!roles.length)
		return "No model roles are available. Call new_context without role.";
	return [
		'Roles are user preferences, not capability limits. Switch only for a clear, sustained change of task or scope, not a single specialised prompt. Any model can do general work. Consider an available subagent for a bounded specialist detour. Save notes, then call new_context({role: "name"}); omit role to keep the current model.',
		...roles.map((role) => `- ${role.id}: ${role.description}`),
	].join("\n");
}

export async function prepareRole(
	catalog: ContextModelRoles | undefined,
	id: string,
	conversationId: ConversationId,
	source: Agent,
	models: Models,
	context: Context,
): Promise<PreparedRole> {
	const role = (await readRoles(catalog, conversationId, context)).find(
		(candidate) => candidate.id === id,
	);
	if (!role)
		throw new Error(
			`Unknown role ${JSON.stringify(id)}. Use a configured role or omit role to keep the current model.`,
		);
	const model = models.getModel(role.provider, role.model);
	if (!model)
		throw new Error(
			`Role ${id} is unavailable. Continue here and ask the user to check its model configuration.`,
		);
	if (
		!(await models.getAuth(model, {
			...(context.abortSignal ? { signal: context.abortSignal } : {}),
		}))
	)
		throw new Error(
			`Role ${id} has no usable provider access. Continue here and ask the user to check its login or API configuration.`,
		);
	context.abortSignal?.throwIfAborted();
	return {
		id,
		model: { provider: role.provider, modelId: role.model },
		thinkingLevel: role.reasoning,
		source: {
			model: source.model ?? null,
			thinkingLevel: source.thinkingLevel,
		},
	};
}

/** Checked in the same transaction as the model selection and window cut. */
export async function roleSourceMatches(
	tx: Tx,
	id: ConversationId,
	role: PreparedRole,
) {
	const current = await tx.doc(AgentDoc, id);
	return (
		current.model?.provider === role.source.model?.provider &&
		current.model?.modelId === role.source.model?.modelId &&
		(current.thinkingLevel ?? "off") === role.source.thinkingLevel
	);
}
