import type { Context } from "@earendil-works/chord";
import type { AssistantMessage, Models } from "@earendil-works/pi-ai";
import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { Conversation } from "@earendil-works/pi-durable";

/** Provider usage is a baseline, not an exact measurement of the unsent tail. */
export async function contextUsage(
	conversation: Conversation,
	models: Models,
	context: Context,
	answer?: AssistantMessage,
) {
	const [agent, view] = await Promise.all([
		conversation.agent(context),
		conversation.context(context),
	]);
	const ref = agent.model;
	const model = ref && models.getModel(ref.provider, ref.modelId);
	const contextWindow =
		model && Number.isFinite(model.contextWindow) && model.contextWindow > 0
			? model.contextWindow
			: null;
	const messages = answer ? [...view.messages, answer] : view.messages;
	let baseline: AssistantMessage | undefined;
	// Entry ordering, not wall clocks, determines whether usage describes this head.
	// Retained responses predating a compaction summary describe the old prefix.
	for (const [index, entry] of view.entries.entries()) {
		if (view.head && entry.id <= view.head.id) continue;
		for (const message of view.contributions[index] ?? []) {
			if (message.role === "assistant" && reportedTokens(message) !== null)
				baseline = message;
		}
	}
	if (answer && reportedTokens(answer) !== null) baseline = answer;
	const baselineIndex = baseline ? messages.lastIndexOf(baseline) : -1;
	const usageTokens =
		baseline && baselineIndex >= 0 ? reportedTokens(baseline) : null;
	const trailingTokens =
		usageTokens === null
			? null
			: messages
					.slice(baselineIndex + 1)
					.reduce(
						(tokens, message) => tokens + estimateMessageTokens(message),
						0,
					);
	const usedTokens =
		usageTokens !== null && trailingTokens !== null
			? usageTokens + trailingTokens
			: null;
	const known = contextWindow !== null && usedTokens !== null;
	return {
		known,
		reason: known
			? null
			: contextWindow === null
				? "The active model has no known context window"
				: "No applicable assistant usage in the active context",
		model: ref ? { provider: ref.provider, id: ref.modelId } : null,
		usageModel:
			baseline?.role === "assistant"
				? { provider: baseline.provider, id: baseline.model }
				: null,
		contextWindow,
		usageTokens,
		trailingTokens,
		usedTokens,
		remainingTokens: known ? Math.max(0, contextWindow - usedTokens) : null,
		percentage: known ? (usedTokens / contextWindow) * 100 : null,
		estimated: trailingTokens !== null && trailingTokens > 0,
		uncertainty:
			usageTokens !== null
				? "Provider usage plus an estimated unsent tail; not an exact remaining-token budget"
				: "Usage is unknown; no character-only estimate is presented as measured usage",
	};
}

function reportedTokens(message: AssistantMessage): number | null {
	if (["error", "aborted", "deferred", "pending"].includes(message.stopReason))
		return null;
	const counts = [
		message.usage.input,
		message.usage.output,
		message.usage.cacheRead,
		message.usage.cacheWrite,
	];
	if (!counts.every((count) => Number.isFinite(count) && count >= 0))
		return null;
	const tokens = counts.reduce((sum, count) => sum + count, 0);
	return tokens > 0 ? tokens : null;
}
