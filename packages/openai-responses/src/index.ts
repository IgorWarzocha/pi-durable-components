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
import { createRequestLifecycle } from "./lifecycle.ts";
import { DEFAULT_CODEX_BASE_URL } from "./openai-codex/constants.ts";
import { createErrorMessage } from "./openai-codex/errors.ts";
import {
	extractAccountId,
	resolveCodexWebSocketUrl,
} from "./openai-codex/headers.ts";
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
import { prepareRequestBody, useResponsesLite } from "./preparation.ts";
import { type PrewarmOptions, prewarmPrepared } from "./prewarm.ts";

export type {
	CodexDiagnosticsEvent,
	CodexDiagnosticsSink,
	CodexPrewarmResult,
	OpenAICodexStreamOptions,
	ResponsesBody,
} from "./openai-codex/types.ts";
export type { PrewarmOptions } from "./prewarm.ts";

export interface OpenAIResponsesProviderOptions {
	id?: string;
	baseUrl?: string;
	models?: readonly Model<"openai-codex-responses">[];
	/** Auto enables Lite for supported models with grammar-constrained tools. */
	responsesLite?: boolean | "auto";
	transport?: Transport;
	forceCachedWebSockets?: boolean;
	originator?: string;
	diagnostics?: CodexDiagnosticsSink;
}

export interface OpenAIResponsesProvider
	extends Provider<"openai-codex-responses"> {
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
	options: OpenAIResponsesProviderOptions = {},
): OpenAIResponsesProvider {
	const transportState = createCodexTransportState();
	const lifecycle = createRequestLifecycle();
	const config = {
		forceCachedWebSockets: options.forceCachedWebSockets ?? true,
		originator: options.originator ?? "pi-durable-openai-responses",
	};
	const id = options.id ?? "openai-codex";
	const baseUrl = options.baseUrl ?? DEFAULT_CODEX_BASE_URL;
	const models = (options.models ?? openAICodexProviderModels()).map(
		(model) => ({
			...model,
			provider: id,
			baseUrl: options.baseUrl ?? model.baseUrl,
		}),
	);
	const transport = options.transport ?? "websocket-cached";
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
				toolChoice !== undefined &&
				toolChoice !== "auto" &&
				toolChoice !== "none" &&
				toolChoice !== "required"
			)
				throw new Error(
					"Codex Responses does not support named tool selection",
				);
			if (streamOptions?.deferred)
				throw new Error("Codex Responses does not support deferred generation");
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
						useResponsesLite(
							options.responsesLite ?? "auto",
							selected,
							context,
						),
					turnState: current.turnState,
					getDiagnostics: () => options.diagnostics,
					prepareRequestBody,
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
			if ("body" in source) body = source.body;
			else {
				const context = normalizeContext(source.context);
				body = await prepareRequestBody(
					model,
					context,
					effective,
					useResponsesLite(options.responsesLite ?? "auto", model, context),
				);
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
		name: "Optimised OpenAI Codex Responses",
		baseUrl,
		auth: { oauth: openaiCodexNativeOAuthProvider },
		getModels: () => models,
		filterModels: (available) =>
			available.filter((model) => model.id !== "gpt-reserve"),
		stream,
		streamSimple: stream,
		prewarm: (model, context, warmOptions) =>
			warm(model, { context }, warmOptions),
		prewarmPrepared: (model, body, warmOptions) =>
			warm(model, { body }, warmOptions),
		getCanonicalRequest(model, sessionId, apiKey, reconstructedInput) {
			const identity = {
				url: resolveCodexWebSocketUrl(model.baseUrl),
				accountId: extractAccountId(apiKey),
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
