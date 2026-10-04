import { createHash } from "node:crypto";
import { clearCanonicalSessions } from "./session-continuity.ts";
import type { CodexTransportState } from "./transport-state.ts";
import type {
	AcquiredWebSocket,
	ProviderEnv,
	SessionWebSocketCacheEntry,
	WebSocketLike,
} from "./types.ts";
import {
	closeWebSocketSilently,
	connectWebSocket,
	isWebSocketReusable,
	resolveWebSocketProxyForTarget,
} from "./websocket-connection.ts";

const CONTINUATION_HEADERS = new Set([
	"openai-beta",
	"session-id",
	"thread-id",
	"x-client-request-id",
]);

function routeIdentityHeaders(headers: Headers): [string, string][] {
	return [...headers.entries()]
		.filter(([name]) => !CONTINUATION_HEADERS.has(name.toLowerCase()))
		.sort(([left], [right]) => left.localeCompare(right));
}

async function websocketRouteKey(
	url: string,
	headers: Headers,
	accountId: string,
	env: ProviderEnv | undefined,
): Promise<string> {
	const proxy = await resolveWebSocketProxyForTarget(url, env);
	const handshakeIdentity = JSON.stringify([
		accountId,
		new URL(url).href,
		proxy ?? null,
		routeIdentityHeaders(headers),
	]);
	return createHash("sha256").update(handshakeIdentity).digest("base64url");
}

export function isWebSocketSseFallbackActive(
	transportState: CodexTransportState,
	sessionId: string | undefined,
): boolean {
	return sessionId
		? transportState.websocketSseFallbackSessions.has(sessionId)
		: false;
}

export function recordWebSocketSseFallback(
	transportState: CodexTransportState,
	sessionId: string | undefined,
): void {
	if (sessionId) transportState.websocketSseFallbackSessions.add(sessionId);
}

function closeWebSocketSessions(
	transportState: CodexTransportState,
	sessionId: string | undefined,
): void {
	for (const [controller, owner] of transportState.connections) {
		if (sessionId === undefined || owner === sessionId) controller.abort();
	}
	for (const [socket, owner] of transportState.sockets) {
		if (sessionId === undefined || owner === sessionId) {
			closeWebSocketSilently(socket, 1000, "session_shutdown");
			transportState.sockets.delete(socket);
		}
	}
	// A connecting preparation is not yet in the socket cache, but belongs to
	// the same session teardown boundary as a connected lease.
	const preparations = sessionId
		? [transportState.websocketPreparations.get(sessionId)]
		: [...transportState.websocketPreparations.values()];
	for (const controllers of preparations) {
		for (const controller of controllers ?? []) controller.abort();
	}
	const closeEntry = (entry: SessionWebSocketCacheEntry) => {
		closeWebSocketSilently(entry.socket, 1000, "session_shutdown");
	};

	if (sessionId) {
		for (const entry of transportState.websocketSessionCache
			.get(sessionId)
			?.values() ?? [])
			closeEntry(entry);
		transportState.websocketSessionCache.delete(sessionId);
		return;
	}

	for (const routeEntries of transportState.websocketSessionCache.values()) {
		for (const entry of routeEntries.values()) closeEntry(entry);
	}
	transportState.websocketSessionCache.clear();
}

export function closeOpenAICodexWebSocketSessions(
	transportState: CodexTransportState,
	sessionId?: string,
): void {
	closeWebSocketSessions(transportState, sessionId);
	clearCanonicalSessions(transportState, sessionId);
	if (sessionId) {
		transportState.websocketSseFallbackSessions.delete(sessionId);
		return;
	}
	transportState.websocketSseFallbackSessions.clear();
}

/** Call after aborting and joining owned requests, so no new sockets can appear. */
export async function waitForCodexTransportClose(
	transportState: CodexTransportState,
	sessionId?: string,
): Promise<void> {
	await Promise.all(
		[...transportState.socketClosures]
			.filter(([, owner]) => sessionId === undefined || owner === sessionId)
			.map(([closed]) => closed),
	);
}

// A preparation lease owns only the handshake. No response or history state
// advances until handoff validates the final route and releases the lane.
export function preconnectWebSocket(
	transportState: CodexTransportState,
	url: string,
	headers: Headers,
	sessionId: string,
	accountId: string,
	signal: AbortSignal | undefined,
	connectTimeoutMs: number | undefined,
	env: ProviderEnv | undefined,
	onFailure: (error: unknown) => void,
) {
	const controller = new AbortController();
	let preparations = transportState.websocketPreparations.get(sessionId);
	if (!preparations) {
		preparations = new Set();
		transportState.websocketPreparations.set(sessionId, preparations);
	}
	preparations.add(controller);
	const combinedSignal = signal
		? AbortSignal.any([signal, controller.signal])
		: controller.signal;
	let lease: AcquiredWebSocket | undefined;
	let attemptedRoute: string | undefined;
	let failure: { error: unknown } | undefined;
	const release = (keep: boolean) => {
		combinedSignal.removeEventListener("abort", onAbort);
		preparations.delete(controller);
		if (
			preparations.size === 0 &&
			transportState.websocketPreparations.get(sessionId) === preparations
		)
			transportState.websocketPreparations.delete(sessionId);
		lease?.release({ keep });
		lease = undefined;
	};
	const onAbort = () => release(false);
	combinedSignal.addEventListener("abort", onAbort, { once: true });
	if (combinedSignal.aborted) release(false);
	const operation = (async () => {
		attemptedRoute = await websocketRouteKey(url, headers, accountId, env);
		lease = await acquireWebSocket(
			transportState,
			url,
			headers,
			sessionId,
			accountId,
			combinedSignal,
			connectTimeoutMs,
			env,
		);
		if (combinedSignal.aborted) release(false);
	})().catch((error: unknown) => {
		// Only a failure on the finalized route may influence transport fallback.
		failure = { error };
		if (!combinedSignal.aborted) onFailure(error);
	});
	return {
		async handoff(
			finalUrl: string,
			finalHeaders: Headers,
			finalAccountId: string,
			finalEnv: ProviderEnv | undefined,
			keep: boolean,
		) {
			await operation;
			if (!lease && !failure) return;
			const finalRoute = await websocketRouteKey(
				finalUrl,
				finalHeaders,
				finalAccountId,
				finalEnv,
			);
			const matched =
				keep &&
				!combinedSignal.aborted &&
				(lease?.routeKey ?? attemptedRoute) === finalRoute;
			release(matched);
			return matched ? failure : undefined;
		},
		async close() {
			controller.abort();
			await operation;
			release(false);
		},
	};
}

export async function acquireWebSocket(
	transportState: CodexTransportState,
	url: string,
	headers: Headers,
	sessionId: string | undefined,
	accountId: string,
	signal: AbortSignal | undefined,
	connectTimeoutMs?: number,
	env?: ProviderEnv,
): Promise<AcquiredWebSocket> {
	const controller = new AbortController();
	transportState.connections.set(controller, sessionId);
	try {
		return await acquireOwnedWebSocket(
			transportState,
			url,
			headers,
			sessionId,
			accountId,
			signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
			connectTimeoutMs,
			env,
		);
	} finally {
		transportState.connections.delete(controller);
	}
}

async function connectOwnedWebSocket(
	transportState: CodexTransportState,
	url: string,
	headers: Headers,
	sessionId: string | undefined,
	signal: AbortSignal | undefined,
	connectTimeoutMs: number | undefined,
	env: ProviderEnv | undefined,
): Promise<WebSocketLike> {
	const socket = await connectWebSocket(
		url,
		headers,
		signal,
		connectTimeoutMs,
		env,
		(socket) => {
			transportState.sockets.set(socket, sessionId);
			let resolveClosed!: () => void;
			const closedEvent = new Promise<void>((resolve) => {
				resolveClosed = resolve;
			});
			const closed = socket.closed ?? closedEvent;
			transportState.socketClosures.set(closed, sessionId);
			void closed.then(
				() => transportState.socketClosures.delete(closed),
				() => {},
			);
			const onClose = () => {
				transportState.sockets.delete(socket);
				socket.removeEventListener("close", onClose);
				resolveClosed();
			};
			socket.addEventListener("close", onClose);
			if (socket.readyState === 3) onClose();
		},
	);
	if (signal?.aborted) {
		closeWebSocketSilently(socket);
		throw new Error("Request was aborted");
	}
	return socket;
}

async function acquireOwnedWebSocket(
	transportState: CodexTransportState,
	url: string,
	headers: Headers,
	sessionId: string | undefined,
	accountId: string,
	signal: AbortSignal | undefined,
	connectTimeoutMs?: number,
	env?: ProviderEnv,
): Promise<AcquiredWebSocket> {
	if (!sessionId) {
		const socket = await connectOwnedWebSocket(
			transportState,
			url,
			headers,
			sessionId,
			signal,
			connectTimeoutMs,
			env,
		);
		return {
			socket,
			reused: false,
			socketAgeMs: 0,
			release: ({ keep } = {}) => {
				if (keep === false) {
					closeWebSocketSilently(socket);
					return;
				}
				closeWebSocketSilently(socket);
			},
		};
	}

	const routeKey = await websocketRouteKey(url, headers, accountId, env);
	if (signal?.aborted) throw new Error("Request was aborted");
	let routeEntries = transportState.websocketSessionCache.get(sessionId);
	const cached = routeEntries?.get(routeKey);
	if (cached) {
		if (!cached.busy && isWebSocketReusable(cached.socket)) {
			cached.busy = true;
			return {
				socket: cached.socket,
				routeKey,
				entry: cached,
				reused: true,
				socketAgeMs: Math.max(0, Date.now() - cached.createdAtMs),
				release: ({ keep } = {}) => {
					if (!keep || !isWebSocketReusable(cached.socket)) {
						closeWebSocketSilently(cached.socket);
						const currentEntries =
							transportState.websocketSessionCache.get(sessionId);
						if (currentEntries?.get(routeKey) === cached)
							currentEntries.delete(routeKey);
						if (currentEntries?.size === 0)
							transportState.websocketSessionCache.delete(sessionId);
						return;
					}
					cached.busy = false;
				},
			};
		}

		if (cached.busy) {
			const socket = await connectOwnedWebSocket(
				transportState,
				url,
				headers,
				sessionId,
				signal,
				connectTimeoutMs,
				env,
			);
			return {
				socket,
				routeKey,
				reused: false,
				socketAgeMs: 0,
				release: () => {
					closeWebSocketSilently(socket);
				},
			};
		}

		if (!isWebSocketReusable(cached.socket)) {
			closeWebSocketSilently(cached.socket);
			routeEntries?.delete(routeKey);
			if (routeEntries?.size === 0)
				transportState.websocketSessionCache.delete(sessionId);
		}
	}

	const socket = await connectOwnedWebSocket(
		transportState,
		url,
		headers,
		sessionId,
		signal,
		connectTimeoutMs,
		env,
	);
	if (signal?.aborted) {
		closeWebSocketSilently(socket);
		throw new Error("Request was aborted");
	}
	const entry: SessionWebSocketCacheEntry = {
		socket,
		busy: true,
		createdAtMs: Date.now(),
	};
	routeEntries = transportState.websocketSessionCache.get(sessionId);
	if (!routeEntries) {
		routeEntries = new Map();
		transportState.websocketSessionCache.set(sessionId, routeEntries);
	}
	routeEntries.set(routeKey, entry);
	return {
		socket,
		routeKey,
		entry,
		reused: false,
		socketAgeMs: 0,
		release: ({ keep } = {}) => {
			if (!keep || !isWebSocketReusable(entry.socket)) {
				closeWebSocketSilently(entry.socket);
				const currentEntries =
					transportState.websocketSessionCache.get(sessionId);
				if (currentEntries?.get(routeKey) === entry)
					currentEntries.delete(routeKey);
				if (currentEntries?.size === 0)
					transportState.websocketSessionCache.delete(sessionId);
				return;
			}
			entry.busy = false;
		},
	};
}
