import {
	type Api,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	normalizeContext,
	type Provider,
	type SimpleStreamOptions,
	type TranscriptContext,
	type Transport,
} from "@earendil-works/pi-ai";
import { buildBaseOptions } from "@earendil-works/pi-ai/api/simple-options";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createRequestLifecycle } from "./lifecycle.ts";
import { DEFAULT_CODEX_BASE_URL } from "./openai-codex/constants.ts";
import { createErrorMessage } from "./openai-codex/errors.ts";
import { openAICodexProviderModels } from "./openai-codex/model-catalog.ts";
import { openaiCodexNativeOAuthProvider } from "./openai-codex/oauth.ts";
import {
	canonicalCompactionRequestBody,
	resolveCanonicalCompactionPromptInput,
} from "./openai-codex/session-continuity.ts";
import { createCodexTransportStream } from "./openai-codex/transport-recovery.ts";
import { createCodexTransportState } from "./openai-codex/transport-state.ts";
import {
	type CodexCompactionReplayDecision,
	type CodexDiagnosticsSink,
	type CodexPrewarmResult,
	createInitialAssistantMessage,
	type OpenAICodexStreamOptions,
	type ResponsesBody,
} from "./openai-codex/types.ts";
import { closeOpenAICodexWebSocketSessions } from "./openai-codex/websocket.ts";
import { waitForCodexTransportClose } from "./openai-codex/websocket-session-cache.ts";
import { codexCacheKeepaliveSocketSessionId } from "./openai-codex/websocket-stream.ts";
import { directOpenAIOAuth } from "./openai-responses/oauth.ts";
import { prepareRequestBody, useResponsesLite } from "./preparation.ts";
import { type PrewarmOptions, prewarmPrepared } from "./prewarm.ts";
import {
	DIRECT_BASE_URL,
	responsesIdentity,
	responsesWebSocketUrl,
	type WebSocketFallback,
	type WebSocketRuntime,
} from "./protocol.ts";

export type {
	CodexDiagnosticsEvent,
	CodexDiagnosticsSink,
	CodexPrewarmResult,
	OpenAICodexStreamOptions,
	ResponsesBody,
} from "./openai-codex/types.ts";
export type { PrewarmOptions } from "./prewarm.ts";

type ResponsesApi = "openai-codex-responses" | "openai-responses";
export interface OpenAIResponsesProviderOptions<
	TApi extends ResponsesApi = "openai-codex-responses",
> {
	/** Codex remains the default. Direct uses ordinary OpenAI Responses auth and catalog. */
	mode?: TApi extends "openai-responses" ? "direct" : "codex";
	/** workerd uses native authenticated fetch Upgrade, with no Node proxy routing. */
	runtime?: WebSocketRuntime;
	/** Direct is WebSocket-only. Codex keeps its existing SSE recovery unless explicitly disabled. */
	websocketFallback?: WebSocketFallback;
	id?: string;
	baseUrl?: string;
	models?: readonly Model<TApi>[];
	/** Auto enables Lite for supported models with grammar-constrained tools. */
	responsesLite?: boolean | "auto";
	transport?: Transport;
	forceCachedWebSockets?: boolean;
	originator?: string;
	diagnostics?: CodexDiagnosticsSink;
}

export interface OpenAIResponsesProvider<
	TApi extends ResponsesApi = "openai-codex-responses",
> extends Provider<TApi> {
	prewarm(
		model: Model<Api>,
		context: Context,
		options: PrewarmOptions,
	): Promise<CodexPrewarmResult | undefined>;
	/** Warm an authoritative final payload already prepared by the host. */
	prewarmPrepared(
		model: Model<Api>,
		body: ResponsesBody,
		options: PrewarmOptions,
	): Promise<CodexPrewarmResult | undefined>;
	/** A validated snapshot for host-owned native checkpoint requests. Input excludes Lite's request prefix. */
	getCanonicalRequest(
		model: Model<Api>,
		sessionId: string,
		apiKey: string,
		reconstructedInput: readonly unknown[],
	): { body?: ResponsesBody; decision: CodexCompactionReplayDecision };
	resetSession(sessionId: string): Promise<void>;
	close(): Promise<void>;
}

/** Register with the host's Models collection, not the Durable tool registry. */
export function createOpenAIResponsesProvider(
	options: OpenAIResponsesProviderOptions<"openai-responses"> & {
		mode: "direct";
	},
): OpenAIResponsesProvider<"openai-responses">;
export function createOpenAIResponsesProvider(
	options?: OpenAIResponsesProviderOptions<"openai-codex-responses"> & {
		mode?: "codex";
	},
): OpenAIResponsesProvider<"openai-codex-responses">;
export function createOpenAIResponsesProvider(
	options: OpenAIResponsesProviderOptions<ResponsesApi> = {},
): OpenAIResponsesProvider<ResponsesApi> {
	const mode = options.mode ?? "codex";
	const websocketFallback =
		options.websocketFallback ?? (mode === "direct" ? "error" : "sse");
	if (
		mode === "direct" &&
		(options.transport === "sse" || websocketFallback !== "error")
	)
		throw new Error(
			"Direct Responses requires WebSockets without SSE fallback",
		);
	if (mode === "direct" && options.responsesLite === true)
		throw new Error(
			"Responses Lite is not supported by the direct OpenAI endpoint",
		);
	const transportState = createCodexTransportState(mode, options.runtime);
	const lifecycle = createRequestLifecycle();
	const config = {
		websocketFallback,
		forceCachedWebSockets: options.forceCachedWebSockets ?? true,
		originator: options.originator ?? "pi-durable-openai-responses",
	};
	const id = options.id ?? (mode === "direct" ? "openai" : "openai-codex");
	const baseUrl =
		options.baseUrl ??
		(mode === "direct" ? DIRECT_BASE_URL : DEFAULT_CODEX_BASE_URL);
	const models = (
		options.models ??
		(mode === "direct"
			? openaiProvider().getModels()
			: openAICodexProviderModels())
	).map((model) => ({
		...model,
		provider: id,
		baseUrl: options.baseUrl ?? model.baseUrl,
	}));
	const transport = options.transport ?? "websocket-cached";
	const lite = (
		model: Model<Api>,
		context: TranscriptContext,
		request?: OpenAICodexStreamOptions,
	) => {
		if (mode === "direct") {
			if (request?.responsesLite || request?.canonicalCompaction)
				throw new Error(
					"Direct Responses does not support Responses Lite or Codex compaction",
				);
			if (request?.transport === "sse")
				throw new Error(
					"Direct Responses requires WebSockets without SSE fallback",
				);
			return false;
		}
		return useResponsesLite(options.responsesLite ?? "auto", model, context);
	};
	const prepare = (
		model: Model<Api>,
		context: TranscriptContext,
		request: OpenAICodexStreamOptions | undefined,
		responsesLite: boolean,
	) => prepareRequestBody(model, context, request, responsesLite, mode);
	const clearSession = (sessionId: string) => {
		closeOpenAICodexWebSocketSessions(transportState, sessionId);
		closeOpenAICodexWebSocketSessions(
			transportState,
			codexCacheKeepaliveSocketSessionId(sessionId),
		);
	};

	function stream(
		model: Model<Api>,
		context: TranscriptContext,
		streamOptions?: SimpleStreamOptions | OpenAICodexStreamOptions,
	) {
		let operation: ReturnType<typeof lifecycle.begin> | undefined;
		try {
			operation = lifecycle.begin(
				streamOptions?.sessionId,
				streamOptions?.signal,
			);
			const { toolChoice, ...rest } = streamOptions ?? {};
			if (
				mode === "codex" &&
				toolChoice !== undefined &&
				toolChoice !== "auto" &&
				toolChoice !== "none" &&
				toolChoice !== "required"
			)
				throw new Error(
					"Codex Responses does not support named tool selection",
				);
			if (streamOptions?.deferred)
				throw new Error(
					`${mode === "codex" ? "Codex" : "Direct"} Responses does not support deferred generation`,
				);
			const effectiveOptions: OpenAICodexStreamOptions = {
				...rest,
				...(toolChoice ? { toolChoice } : {}),
				signal: operation.signal,
				transport: streamOptions?.transport ?? transport,
			};
			const current = operation;
			const result = createCodexTransportStream(
				model,
				context,
				effectiveOptions,
				{
					transportState,
					getConfig: () => config,
					useResponsesLite: (selected) =>
						lite(selected, context, effectiveOptions),
					turnState: mode === "codex" ? current.turnState : undefined,
					getDiagnostics: () => options.diagnostics,
					prepareRequestBody: prepare,
					onStreamSettled: (message) => current.finish(message),
				},
			);
			return result;
		} catch (error) {
			const output = createErrorMessage(
				createInitialAssistantMessage(model),
				error,
				Boolean(streamOptions?.signal?.aborted),
			);
			operation?.finish(output);
			const result = createAssistantMessageEventStream();
			result.push({
				type: "error",
				reason: output.stopReason === "aborted" ? "aborted" : "error",
				error: output,
			});
			result.end();
			return result;
		}
	}

	async function warm(
		model: Model<Api>,
		source: { context: Context } | { body: ResponsesBody },
		prewarmOptions: PrewarmOptions,
	) {
		const operation = lifecycle.begin(
			prewarmOptions.sessionId,
			prewarmOptions.signal,
		);
		try {
			const effective = {
				...prewarmOptions,
				signal: operation.signal,
				transport: prewarmOptions.transport ?? transport,
			};
			let body: ResponsesBody;
			const context = normalizeContext(
				"context" in source ? source.context : { messages: [] },
			);
			const responsesLite = lite(model, context, effective);
			if ("body" in source) body = source.body;
			else {
				body = await prepare(model, context, effective, responsesLite);
			}
			return await prewarmPrepared(
				transportState,
				config,
				model,
				body,
				effective,
				operation.turnState,
				options.diagnostics,
			);
		} finally {
			operation.finish();
		}
	}

	return {
		id,
		name:
			mode === "direct"
				? "Optimised OpenAI Responses"
				: "Optimised OpenAI Codex Responses",
		baseUrl,
		auth:
			mode === "direct"
				? { ...openaiProvider().auth, oauth: directOpenAIOAuth }
				: { oauth: openaiCodexNativeOAuthProvider },
		getModels: () => models,
		filterModels: (available) =>
			available.filter((model) => model.id !== "gpt-reserve"),
		stream,
		streamSimple: (model, context, request) =>
			stream(
				model,
				context,
				mode === "direct"
					? { ...request, ...buildBaseOptions(model, context, request) }
					: request,
			),
		prewarm: (model, context, warmOptions) =>
			warm(model, { context }, warmOptions),
		prewarmPrepared: (model, body, warmOptions) =>
			warm(model, { body }, warmOptions),
		getCanonicalRequest(model, sessionId, apiKey, reconstructedInput) {
			const identity = {
				url: responsesWebSocketUrl(mode, model.baseUrl),
				accountId: responsesIdentity(mode, apiKey),
			};
			const replay = resolveCanonicalCompactionPromptInput(
				transportState,
				sessionId,
				model.id,
				identity,
				reconstructedInput,
			);
			const body =
				replay.input &&
				canonicalCompactionRequestBody(
					transportState,
					sessionId,
					model.id,
					identity,
				);
			return {
				decision: replay.decision,
				...(body && replay.input
					? { body: { ...body, input: replay.input } }
					: {}),
			};
		},
		resetSession(sessionId) {
			return lifecycle.reset(sessionId, async () => {
				clearSession(sessionId);
				await Promise.all([
					waitForCodexTransportClose(transportState, sessionId),
					waitForCodexTransportClose(
						transportState,
						codexCacheKeepaliveSocketSessionId(sessionId),
					),
				]);
			});
		},
		close() {
			return lifecycle.close(async () => {
				closeOpenAICodexWebSocketSessions(transportState);
				await waitForCodexTransportClose(transportState);
			});
		},
	};
}
