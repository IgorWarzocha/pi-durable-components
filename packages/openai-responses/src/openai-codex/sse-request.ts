import type { Api, Model } from "@earendil-works/pi-ai";
import { DEFAULT_SSE_HEADER_TIMEOUT_MS } from "./constants.ts";
import {
	codexRetryAfterDeadline,
	isRetryableStreamStatus,
	parseErrorResponse,
} from "./errors.ts";
import { headersToRecord, resolveCodexUrl } from "./headers.ts";
import { combineAbortSignals, createSSEHeaderTimeout } from "./sse.ts";
import { CodexProtocolError, createCodexHttpError } from "./stream-events.ts";
import {
	CODEX_TURN_STATE_HEADER,
	type CodexTurnState,
	withCodexTurnStateHeader,
} from "./turn-state.ts";
import type { OpenAICodexStreamOptions } from "./types.ts";

export async function openCodexSSE<TApi extends Api>(
	model: Model<TApi>,
	body: string | Uint8Array,
	baseHeaders: Headers,
	options: OpenAICodexStreamOptions | undefined,
	turnState: CodexTurnState | undefined,
	onRetryableResponse: () => AbortSignal | undefined,
): Promise<Response> {
	// The logical stream loop owns retries, including failures before headers.
	if (options?.signal?.aborted) throw new Error("Request was aborted");
	const headerTimeout = createSSEHeaderTimeout(DEFAULT_SSE_HEADER_TIMEOUT_MS);
	const combinedSignal = combineAbortSignals([
		options?.signal,
		headerTimeout.signal,
	]);
	let response: Response;
	try {
		try {
			response = await (options?.fetch ?? fetch)(
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
			headerTimeout.clear();
		}
	} catch (error) {
		combinedSignal.cleanup();
		if (
			error instanceof Error &&
			(error.name === "AbortError" || error.message === "Request was aborted")
		) {
			throw new Error("Request was aborted");
		}
		throw error;
	} finally {
		headerTimeout.clear();
	}

	let errorSignal: ReturnType<typeof combineAbortSignals> | undefined;
	try {
		const retryAfter = codexRetryAfterDeadline(response.headers);
		// Known failed headers start recovery even if the error body never finishes.
		// The parsed body still owns fatal-code classification, not this clock.
		if (!response.ok && isRetryableStreamStatus(response.status)) {
			errorSignal = combineAbortSignals([
				combinedSignal.signal,
				onRetryableResponse(),
			]);
		}
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

		const info = await parseErrorResponse(
			response,
			errorSignal?.signal ?? combinedSignal.signal,
		);
		const message = info.friendlyMessage || info.message;
		const error = createCodexHttpError(
			message,
			info.code,
			response.status,
			retryAfter,
		);
		throw error;
	} finally {
		errorSignal?.cleanup();
		combinedSignal.cleanup();
	}
}
