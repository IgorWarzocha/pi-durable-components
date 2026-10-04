import { normalizeTimeoutMs } from "./sse.ts";
import type { OpenAICodexStreamOptions } from "./types.ts";

export {
	parseWebSocket,
	startWebSocketOutputOnFirstEvent,
} from "./websocket-parser.ts";
export {
	acquireWebSocket,
	closeOpenAICodexWebSocketSessions,
	isWebSocketSseFallbackActive,
	recordWebSocketSseFallback,
} from "./websocket-session-cache.ts";

export function validateWebSocketTimeoutOptions(
	options: OpenAICodexStreamOptions | undefined,
): void {
	normalizeTimeoutMs(options?.timeoutMs, "timeoutMs");
	normalizeTimeoutMs(
		options?.websocketConnectTimeoutMs,
		"websocketConnectTimeoutMs",
	);
}
