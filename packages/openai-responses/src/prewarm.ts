import type { Api, Model } from "@earendil-works/pi-ai";
import { noThrowCodexDiagnosticsSink } from "./openai-codex/diagnostic-failure.ts";
import {
	buildWebSocketHeaders,
	extractAccountId,
	resolveCodexWebSocketUrl,
} from "./openai-codex/headers.ts";
import {
	applyResponsesLiteWebSocketMetadata,
	isResponsesLiteRequest,
} from "./openai-codex/responses-lite.ts";
import { CodexProtocolError } from "./openai-codex/stream-events.ts";
import {
	type CodexProviderRuntimeConfig,
	getEffectiveCodexTransport,
} from "./openai-codex/transport-recovery.ts";
import type { CodexTransportState } from "./openai-codex/transport-state.ts";
import {
	type CodexTurnState,
	withCodexTurnState,
} from "./openai-codex/turn-state.ts";
import type {
	CodexDiagnosticsSink,
	OpenAICodexStreamOptions,
	ResponsesBody,
} from "./openai-codex/types.ts";
import {
	recordWebSocketSseFallback,
	validateWebSocketTimeoutOptions,
} from "./openai-codex/websocket.ts";
import {
	isWebSocketMessageTooBigError,
	isWebSocketUpgradeRequiredError,
} from "./openai-codex/websocket-connection.ts";
import { prewarmWebSocket } from "./openai-codex/websocket-stream.ts";
import {
	hasRemoteCompactionV2Input,
	withRemoteCompactionV2Feature,
} from "./openai-responses/compaction-v2-feature.ts";
import { assertResponsesBody } from "./preparation.ts";

export type PrewarmOptions = OpenAICodexStreamOptions & {
	apiKey: string;
	sessionId: string;
	/** Keepalive generates a billable response on an isolated socket lane. Never automatic. */
	mode?: "prepare" | "keepalive";
	retainSocket?: boolean;
};

export async function prewarmPrepared(
	state: CodexTransportState,
	config: CodexProviderRuntimeConfig,
	model: Model<Api>,
	body: ResponsesBody,
	options: PrewarmOptions,
	turnState: CodexTurnState,
	diagnostics?: CodexDiagnosticsSink,
) {
	if (
		getEffectiveCodexTransport(
			state,
			options.transport,
			config,
			options.sessionId,
		) === "sse"
	)
		return;
	if (!options.apiKey || !options.sessionId)
		throw new Error("Prewarm requires apiKey and sessionId");
	assertResponsesBody(body);
	validateWebSocketTimeoutOptions(options);
	const accountId = extractAccountId(options.apiKey);
	const requestHeaders = hasRemoteCompactionV2Input(body.input)
		? withRemoteCompactionV2Feature(options.headers)
		: options.headers;
	const headers = buildWebSocketHeaders(
		model.headers,
		requestHeaders,
		accountId,
		options.apiKey,
		options.sessionId,
		config.originator,
	);
	const keepalive = options.mode === "keepalive";
	const affinity = keepalive ? undefined : turnState;
	const websocketBody = withCodexTurnState(
		isResponsesLiteRequest(body)
			? applyResponsesLiteWebSocketMetadata(body)
			: body,
		affinity,
	);
	try {
		return await prewarmWebSocket(
			state,
			model,
			resolveCodexWebSocketUrl(model.baseUrl),
			websocketBody,
			headers,
			accountId,
			options,
			affinity,
			diagnostics,
			keepalive,
			{ kind: keepalive ? "keepalive" : "ordinary", requestSource: "captured" },
			keepalive,
			options.retainSocket ?? true,
		);
	} catch (error) {
		if (
			!options.signal?.aborted &&
			!(error instanceof CodexProtocolError) &&
			(isWebSocketUpgradeRequiredError(error) ||
				isWebSocketMessageTooBigError(error))
		) {
			recordWebSocketSseFallback(state, options.sessionId);
			noThrowCodexDiagnosticsSink(diagnostics)?.({
				type: "fallback",
				lane: "response",
				from: "websocket",
				to: "sse",
				reason: isWebSocketUpgradeRequiredError(error)
					? "upgrade_required"
					: "message_too_big",
			});
			return;
		}
		throw error;
	}
}
