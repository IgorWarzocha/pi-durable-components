import type { Models } from "@earendil-works/pi-ai";
import type { GrokRealtimeConfig } from "./config.ts";

export async function resolveBearer(
	models: Models,
	access: GrokRealtimeConfig["access"],
	signal: AbortSignal,
): Promise<string> {
	signal.throwIfAborted();
	const resolved = await models.getAuth("xai", { signal });
	signal.throwIfAborted();
	if (!resolved?.auth.apiKey)
		throw new Error("No xAI credential is configured in Models");
	if ((resolved.source === "OAuth") !== (access === "oauth"))
		throw new Error(
			"Models resolved a different xAI credential type than selected; configure matching authentication",
		);
	return resolved.auth.apiKey;
}
export async function resolveConnection(
	models: Models,
	config: GrokRealtimeConfig,
	signal: AbortSignal,
) {
	return {
		url: `wss://api.x.ai/v1/realtime?model=${encodeURIComponent(config.model)}`,
		protocols: [],
		headers: {
			Authorization: `Bearer ${await resolveBearer(models, config.access, signal)}`,
		},
	};
}
