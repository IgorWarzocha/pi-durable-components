import type { Context } from "@earendil-works/chord";
import { ProviderDoc, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { CodexRuntimeOptions } from "./types.ts";

export async function callingModel(
	api: ToolExecutionApi,
	options: CodexRuntimeOptions,
	context: Context,
) {
	const reference = (await api.agent(context)).model;
	return reference
		? options.models.getModel(reference.provider, reference.modelId)
		: undefined;
}

export async function providerSessionId(
	api: ToolExecutionApi,
	context: Context,
): Promise<string> {
	const state = await api.snapshot(ProviderDoc, api.conversationId, context);
	if (state) return state.sessionId;
	return api.commit(
		async (tx) => (await tx.doc(ProviderDoc, api.conversationId)).sessionId,
		context,
	);
}
