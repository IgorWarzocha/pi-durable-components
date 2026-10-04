import type {
	ResponsesBody,
	SessionWebSocketCacheEntry,
	WebSocketLike,
} from "./types.ts";

interface CanonicalSessionLane {
	identity: symbol;
	requestSequence: number;
}

export interface CanonicalSessionState {
	accountId: string;
	url: string;
	requestBody: ResponsesBody;
	reconstructedRequestInput: readonly unknown[];
	responseItems: readonly unknown[];
}

/** One provider instance owns its physical sockets and logical continuation lanes. */
export interface CodexTransportState {
	websocketSessionCache: Map<string, Map<string, SessionWebSocketCacheEntry>>;
	websocketPreparations: Map<string, Set<AbortController>>;
	websocketSseFallbackSessions: Set<string>;
	canonicalSessions: Map<string, CanonicalSessionState>;
	canonicalSessionLanes: Map<string, CanonicalSessionLane>;
	sockets: Map<WebSocketLike, string | undefined>;
	socketClosures: Map<Promise<void>, string | undefined>;
	connections: Map<AbortController, string | undefined>;
}

export function createCodexTransportState(): CodexTransportState {
	return {
		websocketSessionCache: new Map(),
		websocketPreparations: new Map(),
		websocketSseFallbackSessions: new Set(),
		canonicalSessions: new Map(),
		canonicalSessionLanes: new Map(),
		sockets: new Map(),
		socketClosures: new Map(),
		connections: new Map(),
	};
}
