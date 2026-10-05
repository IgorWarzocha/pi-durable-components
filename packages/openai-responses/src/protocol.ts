import { createHash } from "node:crypto";
import {
	buildWebSocketHeaders,
	extractAccountId,
	resolveCodexWebSocketUrl,
} from "./openai-codex/headers.ts";
import type { ResponsesBody } from "./openai-codex/types.ts";

export type ResponsesMode = "codex" | "direct";
export type WebSocketFallback = "sse" | "error";
export type WebSocketRuntime = "node" | "workerd";
export const DIRECT_BASE_URL = "https://api.openai.com/v1";

export function responsesIdentity(mode: ResponsesMode, apiKey: string): string {
	return mode === "codex"
		? extractAccountId(apiKey)
		: createHash("sha256").update(apiKey).digest("base64url");
}

export function responsesWebSocketUrl(
	mode: ResponsesMode,
	baseUrl: string,
): string {
	if (mode === "codex") return resolveCodexWebSocketUrl(baseUrl);
	const url = new URL(
		`${baseUrl.replace(/\/+$/, "").replace(/\/responses$/, "")}/responses`,
	);
	if (url.protocol === "https:") url.protocol = "wss:";
	else if (url.protocol === "http:") url.protocol = "ws:";
	else throw new Error("Direct Responses requires an HTTP base URL");
	return url.href;
}

export function responsesWebSocketHeaders(
	mode: ResponsesMode,
	modelHeaders: Record<string, string> | undefined,
	additional: Record<string, string | null> | undefined,
	identity: string,
	token: string,
	sessionId: string,
	originator?: string,
): Headers {
	if (mode === "codex")
		return buildWebSocketHeaders(
			modelHeaders,
			additional,
			identity,
			token,
			sessionId,
			originator,
		);
	const headers = new Headers(modelHeaders);
	if (sessionId) {
		headers.set("session_id", sessionId);
		headers.set("x-client-request-id", sessionId);
	}
	for (const [key, value] of Object.entries(additional ?? {})) {
		if (value === null) headers.delete(key);
		else headers.set(key, value);
	}
	headers.set("Authorization", `Bearer ${token}`);
	return headers;
}

/** HTTP-only fields stay in the canonical body but never reach direct WS. */
export function responsesWebSocketEvent(
	mode: ResponsesMode,
	body: ResponsesBody,
	generate = true,
): string {
	const payload =
		mode === "direct"
			? Object.fromEntries(
					Object.entries(body).filter(
						([key]) => key !== "stream" && key !== "background",
					),
				)
			: body;
	return JSON.stringify({
		type: "response.create",
		...payload,
		...(generate ? {} : { generate: false }),
	});
}
