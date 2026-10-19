import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	appendAssistantMessageDiagnostic,
	createAssistantMessageDiagnostic,
	createAssistantMessageEventStream,
	getDeclaredTools,
	type Model,
	type TranscriptContext,
	type Transport,
} from "@earendil-works/pi-ai";
import type { CompletionObserver } from "../completion.ts";
import { createGrammarToolInputProperties } from "../constrained-sampling.ts";
import {
	hasRemoteCompactionV2Input,
	withRemoteCompactionV2Feature,
} from "../openai-responses/compaction-v2-feature.ts";
import {
	responsesIdentity,
	responsesWebSocketHeaders,
	responsesWebSocketUrl,
	type WebSocketFallback,
} from "../protocol.ts";
import {
	DEFAULT_MAX_RETRY_DELAY_MS,
	DEFAULT_RATE_LIMIT_RECOVERY_BUDGET_MS,
	DEFAULT_SSE_HEADER_TIMEOUT_MS,
	DEFAULT_STREAM_IDLE_TIMEOUT_MS,
	DEFAULT_STREAM_MAX_RETRIES,
	DEFAULT_TRANSPORT_RECOVERY_BUDGET_MS,
	INITIAL_STREAM_RETRY_DELAY_MS,
	MAX_SSE_REQUEST_RETRIES,
	MAX_STREAM_MAX_RETRIES,
	MAX_WEBSOCKET_RECOVERY_RETRIES,
} from "./constants.ts";
import {
	codexDiagnosticsFailure,
	noThrowCodexDiagnosticsSink,
} from "./diagnostic-failure.ts";
import {
	codexRetryAfterDeadline,
	createErrorMessage,
	isRetryableRequestStatus,
	NonRetryableProviderError,
	parseErrorResponse,
} from "./errors.ts";
import {
	buildSSEHeaders,
	createCodexRequestId,
	headersToRecord,
	resolveCodexUrl,
} from "./headers.ts";
import { osInfoReady } from "./node-runtime.ts";
import { resolveCodexTranscript } from "./request-body.ts";
import { serializeCodexRequest } from "./request-serialization.ts";
import { applyResponsesLiteWebSocketMetadata } from "./responses-lite.ts";
import { supportsResponsesLiteModel } from "./responses-lite-model.ts";
import {
	captureCanonicalSessionToken,
	recordCanonicalSessionResponse,
	validateCanonicalSessionRequest,
} from "./session-continuity.ts";
import {
	combineAbortSignals,
	compressRequestBodyZstd,
	createSSEHeaderTimeout,
	normalizeTimeoutMs,
	parseSSE,
	sleep,
} from "./sse.ts";
import {
	assertSuccessfulCodexOutput,
	CodexProtocolError,
	codexOverloadRetryDelay,
	codexStreamRetryDelay,
	createCodexHttpError,
	isCodexApiError,
	isCodexOverloadError,
	isCodexRateLimitError,
	isRetryableCodexStreamError,
	processCodexResponsesStream,
	runCodexCompletionObserver,
} from "./stream-events.ts";
import type { CodexTransportState } from "./transport-state.ts";
import {
	CODEX_TURN_STATE_HEADER,
	type CodexTurnState,
	withCodexTurnState,
	withCodexTurnStateHeader,
} from "./turn-state.ts";
import type {
	BeforeCodexRequestSend,
	CanonicalHistoryDecision,
	CodexDiagnosticsLane,
	CodexDiagnosticsSink,
	CodexProviderStreamOptions,
	CodexUsageRecorder,
	OpenAICodexStreamOptions,
	ResponsesBody,
} from "./types.ts";
import { createInitialAssistantMessage } from "./types.ts";
import { finalizeUsage, readServiceTier } from "./usage.ts";
import {
	isWebSocketSseFallbackActive,
	recordWebSocketSseFallback,
	validateWebSocketTimeoutOptions,
} from "./websocket.ts";
import {
	isPermanentWebSocketError,
	isWebSocketConnectionError,
	isWebSocketMessageTooBigError,
	isWebSocketUnauthorizedError,
	isWebSocketUpgradeRequiredError,
} from "./websocket-connection.ts";
import { preconnectWebSocket } from "./websocket-session-cache.ts";
import { processWebSocketStream } from "./websocket-stream.ts";

export interface CodexProviderRuntimeConfig {
	websocketFallback?: WebSocketFallback;
	forceCachedWebSockets?: boolean;
	originator?: string;
	responsesLite?: boolean;
}

export interface CodexTransportRecoveryDependencies {
	usageModel(model: Model<Api>, modelId: string): Model<Api>;
	onCompletion?: CompletionObserver | undefined;
	canonicalSubscription?: boolean;
	transportState: CodexTransportState;
	getConfig?: () => CodexProviderRuntimeConfig | undefined;
	useResponsesLite?: (model: Model<Api>) => boolean;
	turnState?: CodexTurnState | undefined;
	onPreparedPayload?: ((payload: ResponsesBody) => void) | undefined;
	beforeRequestSend?: BeforeCodexRequestSend | undefined;
	onStreamSettled?: (output: AssistantMessage) => void;
	getDiagnostics?: (() => CodexDiagnosticsSink | undefined) | undefined;
	recordUsage?: CodexUsageRecorder | undefined;
	prepareRequestBody: <TApi extends Api>(
		model: Model<TApi>,
		context: TranscriptContext,
		options: OpenAICodexStreamOptions | undefined,
		responsesLite: boolean,
	) => Promise<ResponsesBody>;
}

function diagnosticsLane(
	body: ResponsesBody,
): Exclude<CodexDiagnosticsLane, "prewarm"> {
	return body.input.some(
		(item) =>
			item &&
			typeof item === "object" &&
			(item as { type?: unknown }).type === "compaction_trigger",
	)
		? "compaction"
		: "response";
}

function recordUsage(
	record: CodexDiagnosticsSink | undefined,
	lane: Exclude<CodexDiagnosticsLane, "prewarm">,
	transport: "websocket" | "sse",
	output: AssistantMessage,
): void {
	record?.({
		type: "usage",
		lane,
		transport,
		inputTokens: output.usage.input,
		cachedInputTokens: output.usage.cacheRead,
		cacheWriteInputTokens: output.usage.cacheWrite,
		outputTokens: output.usage.output,
	});
}

function codexStreamRetryDelayMs(retryCount: number): number {
	const base = INITIAL_STREAM_RETRY_DELAY_MS * 2 ** Math.max(0, retryCount - 1);
	return Math.min(
		DEFAULT_MAX_RETRY_DELAY_MS,
		base * (0.9 + Math.random() * 0.2),
	);
}

function codexStreamMaxRetries(
	options: OpenAICodexStreamOptions | undefined,
): number {
	const configured = options?.maxRetries;
	if (configured === undefined) return DEFAULT_STREAM_MAX_RETRIES;
	if (!Number.isFinite(configured) || configured < 0) {
		throw new Error(`Invalid maxRetries: ${String(configured)}`);
	}
	return Math.min(Math.floor(configured), MAX_STREAM_MAX_RETRIES);
}

function startsToolOutput(event: unknown): boolean {
	if (
		!event ||
		typeof event !== "object" ||
		!("type" in event) ||
		!("item" in event)
	)
		return false;
	if (
		event.type !== "response.output_item.added" &&
		event.type !== "response.output_item.done"
	)
		return false;
	const item = event.item;
	return (
		!!item &&
		typeof item === "object" &&
		"type" in item &&
		(item.type === "function_call" || item.type === "custom_tool_call")
	);
}

function retryAdviceRecoveryBudgetError(
	error: unknown,
): NonRetryableProviderError {
	const requestedDelayMs = codexStreamRetryDelay(error);
	const detail =
		requestedDelayMs === undefined
			? ""
			: ` Provider requested a wait of ${Math.ceil(requestedDelayMs / 1000)} seconds.`;
	return new NonRetryableProviderError(
		`Codex retry delay exceeded the three-minute automatic recovery window.${detail}`,
	);
}

export function getEffectiveCodexTransport(
	transportState: CodexTransportState,
	transport: Transport | undefined,
	config: Pick<CodexProviderRuntimeConfig, "forceCachedWebSockets"> | undefined,
	sessionId?: string | undefined,
): Transport {
	const configuredTransport = transport ?? "auto";
	const preferredTransport =
		config?.forceCachedWebSockets !== false &&
		configuredTransport === "websocket"
			? "websocket-cached"
			: configuredTransport;
	return preferredTransport !== "sse" &&
		isWebSocketSseFallbackActive(transportState, sessionId)
		? "sse"
		: preferredTransport;
}

async function openCodexSSE<TApi extends Api>(
	model: Model<TApi>,
	body: string | Uint8Array,
	baseHeaders: Headers,
	options: OpenAICodexStreamOptions | undefined,
	turnState: CodexTurnState | undefined,
	waitBeforeRetry: (error: unknown, retryCount: number) => Promise<void>,
): Promise<Response> {
	let lastError: Error | undefined;
	const maxRetries =
		options?.maxRetries === undefined
			? MAX_SSE_REQUEST_RETRIES
			: Math.min(codexStreamMaxRetries(options), MAX_SSE_REQUEST_RETRIES);
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		if (options?.signal?.aborted) throw new Error("Request was aborted");
		let response: Response;
		try {
			const headerTimeout = createSSEHeaderTimeout(
				DEFAULT_SSE_HEADER_TIMEOUT_MS,
			);
			const combinedSignal = combineAbortSignals([
				options?.signal,
				headerTimeout.signal,
			]);
			try {
				response = await (options?.fetch ?? globalThis.fetch)(
					resolveCodexUrl(model.baseUrl),
					{
						method: "POST",
						headers: withCodexTurnStateHeader(baseHeaders, turnState),
						body: typeof body === "string" ? body : new Uint8Array(body),
						signal: combinedSignal.signal,
					},
				);
			} catch (error) {
				const timeoutError = headerTimeout.error();
				throw timeoutError && !options?.signal?.aborted ? timeoutError : error;
			} finally {
				combinedSignal.cleanup();
				headerTimeout.clear();
			}
		} catch (error) {
			if (
				error instanceof Error &&
				(error.name === "AbortError" || error.message === "Request was aborted")
			) {
				throw new Error("Request was aborted");
			}
			lastError = error instanceof Error ? error : new Error(String(error));
			if (attempt < maxRetries) {
				await waitBeforeRetry(lastError, attempt + 1);
				continue;
			}
			throw lastError;
		}

		const retryAfter = codexRetryAfterDeadline(response.headers);
		if (response.ok)
			turnState?.capture(response.headers.get(CODEX_TURN_STATE_HEADER));
		try {
			await options?.onResponse?.(
				{ status: response.status, headers: headersToRecord(response.headers) },
				model,
			);
		} catch (error) {
			await response.body?.cancel().catch(() => {});
			throw new CodexProtocolError(
				`Provider response observer failed: ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		}
		if (response.ok) return response;

		const info = await parseErrorResponse(response, options?.signal);
		const message = info.friendlyMessage || info.message;
		const error = createCodexHttpError(
			message,
			info.code,
			response.status,
			retryAfter,
		);
		if (isCodexOverloadError(error)) throw error;
		const requestRetryable =
			isRetryableRequestStatus(response.status) &&
			isRetryableCodexStreamError(error);
		if (requestRetryable && attempt < maxRetries) {
			await waitBeforeRetry(error, attempt + 1);
			continue;
		}
		throw error;
	}
	throw lastError ?? new Error("Failed after retries");
}

export function createCodexTransportStream<TApi extends Api>(
	model: Model<TApi>,
	context: TranscriptContext,
	options: CodexProviderStreamOptions | undefined,
	deps: CodexTransportRecoveryDependencies,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		let output = createInitialAssistantMessage(model);
		let diagnostics: CodexDiagnosticsSink | undefined;
		let effectiveTransport: Transport = options?.transport ?? "auto";
		let effectiveOptions: OpenAICodexStreamOptions = { ...options };
		let lane: Exclude<CodexDiagnosticsLane, "prewarm"> = "response";
		let diagnosticsFailureRecorded = false;
		let preconnectFailure: { error: unknown } | undefined;
		let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
		let preconnect: ReturnType<typeof preconnectWebSocket> | undefined;
		const recordFailure = (transport: "websocket" | "sse", error: unknown) => {
			if (!diagnostics) return;
			diagnosticsFailureRecorded = true;
			diagnostics({
				type: "failure",
				lane,
				transport,
				failure: codexDiagnosticsFailure(error),
			});
		};
		try {
			diagnostics = noThrowCodexDiagnosticsSink(deps.getDiagnostics?.());
			const runtimeConfig = deps.getConfig?.();
			const responsesLite =
				deps.useResponsesLite?.(model) ??
				(runtimeConfig?.responsesLite === true &&
					supportsResponsesLiteModel(model.id));
			const resolvedContext = resolveCodexTranscript(model, context);
			const modelSupportsGrammarTools =
				(
					model.compat as
						| { supportsOpenAIGrammarTools?: boolean | undefined }
						| undefined
				)?.supportsOpenAIGrammarTools ?? false;
			const grammarToolInputProperties = createGrammarToolInputProperties(
				getDeclaredTools(context.messages),
				responsesLite || modelSupportsGrammarTools,
			);
			const preferredTransport = getEffectiveCodexTransport(
				deps.transportState,
				options?.transport,
				runtimeConfig,
			);
			effectiveTransport = getEffectiveCodexTransport(
				deps.transportState,
				options?.transport,
				runtimeConfig,
				options?.sessionId,
			);
			effectiveOptions = {
				...options,
				transport: effectiveTransport,
				grammarToolInputProperties,
			};
			const maxRetryDelayMs = normalizeTimeoutMs(
				effectiveOptions.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS,
				"maxRetryDelayMs",
			);
			const apiKey = effectiveOptions?.apiKey;
			if (!apiKey) {
				throw new Error(`No API key for provider: ${model.provider}`);
			}

			const mode = deps.transportState.mode;
			const allowFallback = runtimeConfig?.websocketFallback !== "error";
			const accountId = responsesIdentity(mode, apiKey);
			const websocketUrl = responsesWebSocketUrl(mode, model.baseUrl);
			const canonicalSessionToken = captureCanonicalSessionToken(
				deps.transportState,
				effectiveOptions?.sessionId,
			);
			const websocketRequestId =
				effectiveOptions?.sessionId || createCodexRequestId();
			const originator =
				runtimeConfig?.originator ?? "pi-durable-openai-responses";
			// Only the handshake overlaps payload rewrites and image preparation.
			if (
				effectiveTransport !== "sse" &&
				runtimeConfig?.forceCachedWebSockets !== false &&
				effectiveOptions.sessionId &&
				!effectiveOptions.canonicalCompaction &&
				effectiveOptions.cacheRetention !== "none"
			) {
				validateWebSocketTimeoutOptions(effectiveOptions);
				// Do not let async OS discovery change the route's User-Agent mid-preparation.
				await osInfoReady;
				preconnect = preconnectWebSocket(
					deps.transportState,
					websocketUrl,
					responsesWebSocketHeaders(
						mode,
						model.headers,
						effectiveOptions.headers,
						accountId,
						apiKey,
						websocketRequestId,
						originator,
						{
							model: model.id,
							service_tier: effectiveOptions.serviceTier ?? undefined,
						},
					),
					effectiveOptions.sessionId,
					accountId,
					effectiveOptions.signal,
					normalizeTimeoutMs(
						effectiveOptions.websocketConnectTimeoutMs,
						"websocketConnectTimeoutMs",
					),
					effectiveOptions.env,
					(error) =>
						diagnostics?.({
							type: "failure",
							lane: "prewarm",
							transport: "websocket",
							failure: codexDiagnosticsFailure(error),
						}),
				);
			}
			const reconstructedBody = await deps.prepareRequestBody(
				model,
				resolvedContext,
				effectiveOptions,
				responsesLite,
			);
			const body = reconstructedBody;
			if (hasRemoteCompactionV2Input(body.input))
				effectiveOptions.headers = withRemoteCompactionV2Feature(
					effectiveOptions.headers,
				);
			if (preconnect) {
				const finalHeaders = responsesWebSocketHeaders(
					mode,
					model.headers,
					effectiveOptions.headers,
					accountId,
					apiKey,
					websocketRequestId,
					originator,
					body,
				);
				const failure = await preconnect.handoff(
					websocketUrl,
					finalHeaders,
					accountId,
					effectiveOptions.env,
					getEffectiveCodexTransport(
						deps.transportState,
						options?.transport,
						runtimeConfig,
						options?.sessionId,
					) !== "sse",
				);
				preconnectFailure = failure;
				if (
					failure &&
					allowFallback &&
					!(failure.error instanceof CodexProtocolError) &&
					(isWebSocketUpgradeRequiredError(failure.error) ||
						isWebSocketMessageTooBigError(failure.error))
				) {
					recordWebSocketSseFallback(
						deps.transportState,
						effectiveOptions.sessionId,
					);
					diagnostics?.({
						type: "fallback",
						lane: diagnosticsLane(body),
						from: "websocket",
						to: "sse",
						reason: isWebSocketUpgradeRequiredError(failure.error)
							? "upgrade_required"
							: "message_too_big",
					});
				}
			}
			await deps.beforeRequestSend?.(
				model,
				resolvedContext,
				body,
				effectiveOptions,
				responsesLite,
			);
			const canonicalHistory: CanonicalHistoryDecision | undefined =
				effectiveOptions?.canonicalCompaction
					? "compaction"
					: validateCanonicalSessionRequest(
							deps.transportState,
							effectiveOptions?.sessionId,
							websocketUrl,
							accountId,
							body,
						);
			lane = diagnosticsLane(body);
			deps.onPreparedPayload?.(body);
			const baseSseHeaders =
				mode === "direct"
					? new Headers()
					: buildSSEHeaders(
							model.headers,
							effectiveOptions?.headers,
							accountId,
							apiKey,
							effectiveOptions?.sessionId,
							responsesLite,
							originator,
							body,
						);
			const websocketHeaders = responsesWebSocketHeaders(
				mode,
				model.headers,
				effectiveOptions?.headers,
				accountId,
				apiKey,
				websocketRequestId,
				originator,
				body,
			);
			const bodyJson = serializeCodexRequest(body);
			const pricingModel = deps.usageModel(model, body.model);
			const observe = async (
				sent: string,
				responseId: string,
				transport: "sse" | "websocket",
			) => {
				if (
					!deps.onCompletion ||
					new TextEncoder().encode(sent).byteLength > 96 * 1024
				)
					return;
				await runCodexCompletionObserver("completion", () =>
					deps.onCompletion?.({
						responseId,
						provider: model.provider,
						api: model.api,
						model: model.id,
						sessionId: effectiveOptions.sessionId,
						url: websocketUrl.replace(/^ws/, "http"),
						transport,
						requestBody: sent,
						canonicalSubscription:
							deps.canonicalSubscription === true &&
							mode === "codex" &&
							resolveCodexUrl(model.baseUrl) ===
								"https://chatgpt.com/backend-api/codex/responses" &&
							![
								...Object.keys(model.headers ?? {}),
								...Object.keys(effectiveOptions.headers ?? {}),
							].some((key) =>
								/^(authorization|chatgpt-account-id|host|x-codex-routing-hint|x-api-key)$/i.test(
									key,
								),
							) &&
							!effectiveOptions.fetch,
					}),
				);
			};
			const websocketBody = responsesLite
				? applyResponsesLiteWebSocketMetadata(body)
				: body;
			const compressedBody =
				allowFallback || effectiveTransport === "sse"
					? compressRequestBodyZstd(bodyJson)
					: null;
			if (compressedBody) baseSseHeaders.set("content-encoding", "zstd");
			const sseBody = compressedBody ?? bodyJson;
			// Final-body preparation may prewarm the main lane and discover a sticky
			// WebSocket incompatibility. Re-read session routing before the real send.
			const transport = getEffectiveCodexTransport(
				deps.transportState,
				options?.transport,
				runtimeConfig,
				options?.sessionId,
			);
			const streamMaxRetries = codexStreamMaxRetries(effectiveOptions);
			let overloadRetryCount = 0;
			let overloadWaitedMs = 0;
			let retryAdviceWaitedMs = 0;
			const callerSignal = effectiveOptions?.signal;
			let recoveryDeadlineAt: number | undefined;
			let recoveryController: AbortController | undefined;
			let websocketRecoveryRetries = 0;
			const recoverySignal = () =>
				recoveryController
					? combineAbortSignals([callerSignal, recoveryController.signal])
					: undefined;
			const startTransportRecovery = (freshWindow = false) => {
				if (freshWindow) {
					if (recoveryTimer) clearTimeout(recoveryTimer);
					recoveryDeadlineAt = undefined;
				}
				if (recoveryDeadlineAt !== undefined) return;
				// Never charge a long, healthy initial response against the recovery window.
				recoveryDeadlineAt =
					performance.now() + DEFAULT_TRANSPORT_RECOVERY_BUDGET_MS;
				recoveryController = new AbortController();
				recoveryTimer = setTimeout(
					() => recoveryController?.abort(),
					DEFAULT_TRANSPORT_RECOVERY_BUDGET_MS,
				);
			};
			const recoveryDeadlineError = () =>
				new NonRetryableProviderError(
					"Codex could not complete transport recovery within five minutes; the request was stopped before an answer completed. Retry the request.",
				);
			const recoveryExpired = () =>
				recoveryController?.signal.aborted === true ||
				(recoveryDeadlineAt !== undefined &&
					performance.now() >= recoveryDeadlineAt);
			const planRetry = (error: unknown, retryCount: number) => {
				const overload = isCodexOverloadError(error);
				const requestedDelayMs = codexStreamRetryDelay(error);
				if (
					requestedDelayMs !== undefined &&
					maxRetryDelayMs !== undefined &&
					maxRetryDelayMs > 0 &&
					requestedDelayMs > maxRetryDelayMs
				) {
					throw new NonRetryableProviderError(
						`Codex requested a retry wait of ${Math.ceil(requestedDelayMs / 1000)} seconds, exceeding maxRetryDelayMs (${maxRetryDelayMs}ms).`,
					);
				}
				const serverDirected =
					requestedDelayMs !== undefined || isCodexRateLimitError(error);
				const fallbackDelayMs = codexStreamRetryDelayMs(retryCount);
				const delayMs = overload
					? codexOverloadRetryDelay(error, overloadRetryCount, overloadWaitedMs)
					: (requestedDelayMs ?? fallbackDelayMs);
				const adviceBudgetExhausted =
					serverDirected &&
					(delayMs === undefined ||
						delayMs >
							Math.max(
								0,
								DEFAULT_RATE_LIMIT_RECOVERY_BUDGET_MS - retryAdviceWaitedMs,
							));
				return {
					overload,
					serverDirected,
					adviceBudgetExhausted,
					delayMs: adviceBudgetExhausted ? undefined : delayMs,
				};
			};
			const waitBeforeRetry = async (
				error: unknown,
				retryCount: number,
				plan = planRetry(error, retryCount),
				switchingOnExpiry = false,
			) => {
				if (plan.delayMs === undefined)
					throw retryAdviceRecoveryBudgetError(error);
				// Hooks and diagnostics may take time. Expired advice means zero,
				// not another full delay or a fresh local backoff.
				const delayMs = codexStreamRetryDelay(error) ?? plan.delayMs;
				if (
					!switchingOnExpiry &&
					recoveryDeadlineAt !== undefined &&
					delayMs > Math.max(0, recoveryDeadlineAt - performance.now())
				) {
					throw new NonRetryableProviderError(
						"Codex retry advice exceeds the remaining transport recovery window; retry the request later.",
					);
				}
				const retrySignal = recoverySignal();
				try {
					await sleep(delayMs, retrySignal?.signal ?? callerSignal);
				} finally {
					retrySignal?.cleanup();
				}
				if (plan.overload) {
					overloadRetryCount++;
					overloadWaitedMs += delayMs;
				}
				if (plan.serverDirected) retryAdviceWaitedMs += delayMs;
			};

			let streamStarted = false;
			if (transport !== "sse") {
				validateWebSocketTimeoutOptions(effectiveOptions);
				for (let attempt = 0; attempt <= streamMaxRetries; attempt++) {
					// Live tool-call events must never be replayed by transport recovery.
					if (attempt > 0) output = createInitialAssistantMessage(model);
					if (recoveryDeadlineAt !== undefined) websocketRecoveryRetries++;
					const attemptSignal = recoverySignal();
					const attemptOptions = attemptSignal
						? { ...effectiveOptions, signal: attemptSignal.signal }
						: effectiveOptions;
					let websocketStarted = false;
					let toolOutputStarted = false;
					try {
						// A failed speculative handshake is the initial attempt, not a free reconnect.
						if (attempt === 0 && preconnectFailure)
							throw preconnectFailure.error;
						await processWebSocketStream(
							deps.transportState,
							websocketUrl,
							withCodexTurnState(websocketBody, deps.turnState),
							websocketHeaders,
							output,
							stream,
							pricingModel,
							accountId,
							() => {
								websocketStarted = true;
								if (!streamStarted) {
									streamStarted = true;
									stream.push({ type: "start", partial: output });
								}
							},
							{
								...attemptOptions,
								onProviderStreamEvent: (event, selected) => {
									toolOutputStarted ||= startsToolOutput(event);
									return effectiveOptions.onProviderStreamEvent?.(
										event,
										selected,
									);
								},
							},
							deps.turnState,
							diagnostics
								? { lane, attempt: attempt + 1, record: diagnostics }
								: undefined,
							{
								reconstructedRequestBody: reconstructedBody,
								token: canonicalSessionToken,
								decision: canonicalHistory,
							},
							(sent, id) => observe(sent, id, "websocket"),
						);
						if (callerSignal?.aborted) throw new Error("Request was aborted");
						if (recoveryExpired()) throw recoveryDeadlineError();
						finalizeUsage(output);
						assertSuccessfulCodexOutput(output);
						recordUsage(diagnostics, lane, "websocket", output);
						await runCodexCompletionObserver("usage", () =>
							deps.recordUsage?.(
								accountId,
								{ ...model, id: body.model },
								output.usage,
							),
						);
						stream.push({
							type: "done",
							reason: output.stopReason,
							message: output,
						});
						stream.end();
						return;
					} catch (error) {
						if (callerSignal?.aborted) throw error;
						const upgradeRequired = isWebSocketUpgradeRequiredError(error);
						const messageTooBig = isWebSocketMessageTooBigError(error);
						const unauthorized = isWebSocketUnauthorizedError(error);
						const retryableWebSocketError =
							!(error instanceof NonRetryableProviderError) &&
							(allowFallback ||
								!(upgradeRequired || messageTooBig || unauthorized)) &&
							(isCodexApiError(error) || !isPermanentWebSocketError(error)) &&
							isRetryableCodexStreamError(error);
						const connectionFailure =
							!isCodexApiError(error) && isWebSocketConnectionError(error);
						if (retryableWebSocketError && connectionFailure)
							startTransportRecovery();
						const retryPlan = planRetry(error, attempt + 1);
						const websocketRecoveryExhausted =
							recoveryExpired() ||
							(retryableWebSocketError &&
								(websocketRecoveryRetries >= MAX_WEBSOCKET_RECOVERY_RETRIES ||
									(recoveryDeadlineAt !== undefined &&
										retryPlan.delayMs !== undefined &&
										retryPlan.delayMs >=
											recoveryDeadlineAt - performance.now())));
						const overloadBudgetExhausted =
							retryPlan.overload && retryPlan.delayMs === undefined;
						const adviceBudgetExhausted = retryPlan.adviceBudgetExhausted;
						const immediateFallback =
							allowFallback &&
							!(error instanceof CodexProtocolError) &&
							(upgradeRequired || messageTooBig || unauthorized);
						const fallbackArmed =
							allowFallback &&
							(immediateFallback ||
								(retryableWebSocketError &&
									(websocketRecoveryExhausted ||
										attempt >= streamMaxRetries ||
										overloadBudgetExhausted)));
						appendAssistantMessageDiagnostic(
							output,
							createAssistantMessageDiagnostic(
								retryableWebSocketError
									? "provider_transport_failure"
									: "provider_stream_failure",
								error,
								{
									configuredTransport: preferredTransport,
									...(fallbackArmed ? { fallbackTransport: "sse" } : {}),
									eventsEmitted: websocketStarted,
									phase: websocketStarted
										? "after_message_stream_start"
										: "before_message_stream_start",
									requestBytes: new TextEncoder().encode(bodyJson).byteLength,
								},
							),
						);
						if (
							toolOutputStarted &&
							(retryableWebSocketError ||
								immediateFallback ||
								websocketRecoveryExhausted)
						) {
							if (allowFallback)
								recordWebSocketSseFallback(
									deps.transportState,
									effectiveOptions.sessionId,
								);
							recordFailure("websocket", error);
							throw new NonRetryableProviderError(
								"The response was interrupted while composing tool calls. Unfinished calls were discarded. Retry your request.",
							);
						}
						if (
							!immediateFallback &&
							!websocketRecoveryExhausted &&
							retryableWebSocketError &&
							attempt < streamMaxRetries &&
							!overloadBudgetExhausted &&
							!adviceBudgetExhausted
						) {
							diagnostics?.({
								type: "retry",
								lane,
								transport: "websocket",
								attempt: attempt + 2,
								...(retryPlan.delayMs !== undefined
									? { delayMs: retryPlan.delayMs }
									: {}),
								failure: codexDiagnosticsFailure(error),
							});
							try {
								await waitBeforeRetry(error, attempt + 1, retryPlan, true);
								continue;
							} catch (waitError) {
								if (callerSignal?.aborted || !recoveryExpired())
									throw waitError;
							}
						}
						if (adviceBudgetExhausted && retryableWebSocketError) {
							throw retryAdviceRecoveryBudgetError(error);
						}
						if (
							!allowFallback ||
							(!retryableWebSocketError && !immediateFallback) ||
							(!fallbackArmed && !recoveryExpired())
						) {
							recordFailure("websocket", error);
							if (recoveryExpired() && retryableWebSocketError)
								throw recoveryDeadlineError();
							if (
								websocketStarted &&
								!(error instanceof NonRetryableProviderError) &&
								!(error instanceof CodexProtocolError) &&
								!isCodexApiError(error)
							) {
								throw new NonRetryableProviderError(
									"Codex stream ended after output began and cannot be continued from its incomplete response.",
								);
							}
							throw error;
						}
						// SSE owns a fresh recovery window, not the exhausted socket signal.
						startTransportRecovery(true);
						// A transport switch is still another request to the same backend.
						if (!immediateFallback && retryPlan.serverDirected)
							await waitBeforeRetry(error, attempt + 1, retryPlan);
						// Pi supplies resolved request auth, not a force-refresh handle. Keep 401
						// fallback turn-local so refreshed auth can use WebSockets on the next turn.
						if (!unauthorized)
							recordWebSocketSseFallback(
								deps.transportState,
								effectiveOptions?.sessionId,
							);
						diagnostics?.({
							type: "fallback",
							lane,
							from: "websocket",
							to: "sse",
							reason: upgradeRequired
								? "upgrade_required"
								: messageTooBig
									? "message_too_big"
									: unauthorized
										? "unauthorized"
										: "retry_budget_exhausted",
						});
						output = createInitialAssistantMessage(model);
						break;
					} finally {
						attemptSignal?.cleanup();
					}
				}
			}

			if (effectiveTransport !== "sse" && transport === "sse")
				startTransportRecovery();
			const sseIdleTimeoutMs = normalizeTimeoutMs(
				effectiveOptions?.timeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
				"timeoutMs",
			);
			for (let attempt = 0; attempt <= streamMaxRetries; attempt++) {
				if (attempt > 0) output = createInitialAssistantMessage(model);
				if (callerSignal?.aborted) throw new Error("Request was aborted");
				if (recoveryExpired()) throw recoveryDeadlineError();
				const sseSignal = recoverySignal();
				const sseOptions = sseSignal
					? { ...effectiveOptions, signal: sseSignal.signal }
					: effectiveOptions;
				let toolOutputStarted = false;
				const responseItems: unknown[] = [];
				let completedId: string | undefined;
				try {
					if (effectiveOptions?.compactionDiagnostics) {
						Object.assign(effectiveOptions.compactionDiagnostics, {
							transport: "sse",
							continuation: undefined,
							continuationMismatch: undefined,
							previousResponseId: false,
							fullInputItems: body.input.length,
							sentInputItems: body.input.length,
						});
					}
					diagnostics?.({
						type: "request",
						lane,
						transport: "sse",
						attempt: attempt + 1,
						fullInputItems: body.input.length,
						sentInputItems: body.input.length,
						model: body.model,
						...(canonicalHistory ? { canonicalHistory } : {}),
						...(effectiveOptions?.compactionDiagnostics
							? {
									compaction: structuredClone(
										effectiveOptions.compactionDiagnostics,
									),
								}
							: {}),
					});
					const response = await openCodexSSE(
						model,
						sseBody,
						baseSseHeaders,
						sseOptions,
						deps.turnState,
						waitBeforeRetry,
					);
					if (!response.body) throw new Error("No response body");
					if (!streamStarted) {
						streamStarted = true;
						stream.push({ type: "start", partial: output });
					}
					await processCodexResponsesStream(
						parseSSE(response, sseOptions.signal, sseIdleTimeoutMs),
						output,
						stream,
						pricingModel,
						{
							...sseOptions,
							serviceTier: readServiceTier(body.service_tier),
							onProviderStreamEvent: async (event, selected) => {
								toolOutputStarted ||= startsToolOutput(event);
								const raw = event as {
									type?: string;
									response?: { status?: string; id?: string };
								};
								if (
									raw.type === "response.completed" &&
									raw.response?.status === "completed" &&
									typeof raw.response.id === "string"
								)
									completedId = raw.response.id;
								await effectiveOptions.onProviderStreamEvent?.(event, selected);
							},
							onOutputItemDone: (item) => responseItems.push(item),
						},
					);
					finalizeUsage(output);
					if (callerSignal?.aborted) throw new Error("Request was aborted");
					if (recoveryExpired()) throw recoveryDeadlineError();
					assertSuccessfulCodexOutput(output);
					if (completedId && completedId === output.responseId)
						await observe(bodyJson, completedId, "sse");
					recordUsage(diagnostics, lane, "sse", output);
					await runCodexCompletionObserver("usage", () =>
						deps.recordUsage?.(
							accountId,
							{ ...model, id: body.model },
							output.usage,
						),
					);
					await runCodexCompletionObserver("output item", async () => {
						for (const item of responseItems)
							await effectiveOptions?.onOutputItemDone?.(item);
					});
					if (!effectiveOptions?.canonicalCompaction)
						recordCanonicalSessionResponse(deps.transportState, {
							sessionId: effectiveOptions?.sessionId,
							url: websocketUrl,
							accountId,
							requestBody: body,
							reconstructedRequestBody: reconstructedBody,
							responseItems,
							token: canonicalSessionToken,
						});
					stream.push({
						type: "done",
						reason: output.stopReason,
						message: output,
					});
					stream.end();
					return;
				} catch (error) {
					if (callerSignal?.aborted) throw error;
					if (recoveryExpired()) {
						const deadlineError = recoveryDeadlineError();
						recordFailure("sse", deadlineError);
						throw deadlineError;
					}
					const retryable =
						!(error instanceof NonRetryableProviderError) &&
						isRetryableCodexStreamError(error);
					const retryPlan = planRetry(error, attempt + 1);
					const overloadBudgetExhausted =
						retryPlan.overload && retryPlan.delayMs === undefined;
					const adviceBudgetExhausted = retryPlan.adviceBudgetExhausted;
					appendAssistantMessageDiagnostic(
						output,
						createAssistantMessageDiagnostic(
							retryable
								? "provider_transport_failure"
								: "provider_stream_failure",
							error,
							{
								configuredTransport: preferredTransport,
								eventsEmitted: output.content.length > 0,
								phase:
									output.content.length > 0
										? "after_message_stream_start"
										: "before_message_stream_start",
								requestBytes: new TextEncoder().encode(bodyJson).byteLength,
							},
						),
					);
					if (toolOutputStarted && retryable) {
						recordFailure("sse", error);
						throw new NonRetryableProviderError(
							"The response was interrupted while composing tool calls. Unfinished calls were discarded. Retry your request.",
						);
					}
					if (
						retryable &&
						attempt < streamMaxRetries &&
						!overloadBudgetExhausted &&
						!adviceBudgetExhausted
					) {
						diagnostics?.({
							type: "retry",
							lane,
							transport: "sse",
							attempt: attempt + 2,
							...(retryPlan.delayMs !== undefined
								? { delayMs: retryPlan.delayMs }
								: {}),
							failure: codexDiagnosticsFailure(error),
						});
						await waitBeforeRetry(error, attempt + 1, retryPlan);
						continue;
					}
					if (adviceBudgetExhausted && retryable) {
						throw retryAdviceRecoveryBudgetError(error);
					}
					recordFailure("sse", error);
					if (retryable && recoveryDeadlineAt !== undefined)
						throw new NonRetryableProviderError(
							"Codex WebSocket recovery and SSE fallback did not complete a response. Retry the request.",
						);
					if (retryable)
						throw new NonRetryableProviderError(
							"Codex stream retry budget was exhausted before a response completed.",
						);
					throw error;
				} finally {
					sseSignal?.cleanup();
				}
			}
		} catch (error) {
			if (!diagnosticsFailureRecorded)
				recordFailure(
					effectiveTransport === "sse" ? "sse" : "websocket",
					error,
				);
			output.content = output.content.filter(
				(block) => block.type !== "toolCall",
			);
			stream.push({
				type: "error",
				reason: (effectiveOptions?.signal?.aborted ? "aborted" : "error") as
					| "aborted"
					| "error",
				error: createErrorMessage(
					output,
					error,
					!!effectiveOptions?.signal?.aborted,
				),
			});
			stream.end();
		} finally {
			try {
				if (recoveryTimer) clearTimeout(recoveryTimer);
				await preconnect?.close();
			} finally {
				deps.onStreamSettled?.(output);
			}
		}
	})();

	return stream;
}
