import type { Models } from "@earendil-works/pi-ai";
import type { PublicRealtimeAccess } from "./realtime-auth.ts";

export interface CodexVoiceAuth {
	headers: Headers;
	baseUrl: string;
	officialCodex: boolean;
	loginFailure?(): Error;
	env?: Record<string, string>;
	realtime?: PublicRealtimeAccess;
}

const loginFailure = () =>
	new Error(
		"Voice requires a canonical OpenAI Codex OAuth login configured by the host",
	);
function canonical(value: string | undefined): boolean {
	if (!value) return false;
	try {
		const url = new URL(value);
		return (
			url.origin === "https://chatgpt.com" &&
			!url.username &&
			!url.password &&
			!url.search &&
			!url.hash &&
			["/backend-api", "/backend-api/codex"].includes(
				url.pathname.replace(/\/+$/, ""),
			)
		);
	} catch {
		return false;
	}
}

export async function resolveCodexVoiceAuth(
	models: Models,
	conversationId: string,
	signal: AbortSignal,
): Promise<CodexVoiceAuth> {
	signal.throwIfAborted();
	const provider = models.getProvider("openai-codex");
	if (!provider?.auth.oauth || !canonical(provider.baseUrl))
		throw loginFailure();
	try {
		if ((await models.checkAuth("openai-codex", { signal }))?.type !== "oauth")
			throw loginFailure();
		const resolved = await models.getAuth("openai-codex", { signal });
		if (
			!resolved ||
			(resolved.auth.baseUrl !== undefined && !canonical(resolved.auth.baseUrl))
		)
			throw loginFailure();
		const token = resolved.auth.apiKey;
		if (!token || token.split(".").length !== 3) throw loginFailure();
		const payload: unknown = JSON.parse(
			Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
		);
		if (
			!payload ||
			typeof payload !== "object" ||
			!("https://api.openai.com/auth" in payload)
		)
			throw loginFailure();
		const identity = payload["https://api.openai.com/auth"];
		if (
			!identity ||
			typeof identity !== "object" ||
			!("chatgpt_account_id" in identity) ||
			typeof identity.chatgpt_account_id !== "string" ||
			!identity.chatgpt_account_id
		)
			throw loginFailure();
		const headers = new Headers();
		for (const [name, value] of Object.entries(resolved.auth.headers ?? {}))
			if (value !== null) headers.set(name, value);
		headers.set("authorization", `Bearer ${token}`);
		headers.set("chatgpt-account-id", identity.chatgpt_account_id);
		headers.set("originator", "pi");
		headers.set("x-session-id", String(conversationId));
		headers.set("user-agent", "pi-durable-gippity-voice");
		return {
			headers,
			baseUrl: "https://chatgpt.com/backend-api/codex",
			officialCodex: true,
			loginFailure,
			...(resolved.env ? { env: resolved.env } : {}),
		};
	} catch (error) {
		if (signal.aborted) throw error;
		throw loginFailure();
	}
}
