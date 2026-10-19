import type { Duplex } from "node:stream";
import { Agent, ProxyAgent, WebSocket } from "undici";
import type { WebSocketLike } from "./types.ts";

/** Only explicit provider environment is consulted. No process.env mutation. */
export async function resolveWebSocketProxyForTarget(
	url: string,
	env: Record<string, string> = {},
): Promise<string | undefined> {
	const target = new URL(url);
	const get = (key: string) => env[key] || env[key.toUpperCase()] || "";
	const scheme =
		target.protocol === "wss:"
			? "https"
			: target.protocol === "ws:"
				? "http"
				: target.protocol.slice(0, -1);
	const port = Number(target.port) || (scheme === "https" ? 443 : 80);
	const hostname = target.hostname.toLowerCase();
	const bypass = (get("npm_config_no_proxy") || get("no_proxy"))
		.toLowerCase()
		.split(/[,\s]/)
		.filter(Boolean);
	if (
		bypass.some((host) => {
			if (host === "*") return true;
			const match = host.match(/^(.+):(\d+)$/);
			if (match && Number(match[2]) !== port) return false;
			const name = match?.[1] ?? host;
			return /^[.*]/.test(name)
				? hostname.endsWith(name.replace(/^\*/, ""))
				: hostname === name;
		})
	)
		return undefined;
	const proxy =
		get(`npm_config_${scheme}_proxy`) ||
		get(`${scheme}_proxy`) ||
		get("npm_config_proxy") ||
		get("all_proxy");
	return proxy
		? proxy.includes("://")
			? proxy
			: `${scheme}://${proxy}`
		: undefined;
}

export function closeWebSocketSilently(
	socket: WebSocketLike,
	code = 1000,
	reason = "done",
): void {
	try {
		socket.close(code, reason);
	} catch {
		/* already closed */
	}
}

export function extractWebSocketError(event: unknown): Error {
	if (
		event &&
		typeof event === "object" &&
		"error" in event &&
		event.error instanceof Error
	)
		return event.error;
	return new Error("Codex dictation WebSocket failed");
}

export async function connectWebSocket(
	url: string,
	headers: Headers,
	signal: AbortSignal,
	timeoutMs: number,
	env?: Record<string, string>,
): Promise<WebSocketLike> {
	signal.throwIfAborted();
	const proxy = await resolveWebSocketProxyForTarget(url, env);
	signal.throwIfAborted();
	const owner = proxy ? new ProxyAgent(proxy) : new Agent();
	let transport: Duplex | undefined;
	// Public Undici interception retains ownership of the upgraded socket. A
	// remote peer that ignores Close must not outlive a cancelled dictation.
	const dispatcher = owner.compose(
		(dispatch) => (request, handler) =>
			dispatch(request, {
				onRequestStart: (...args) => handler.onRequestStart?.(...args),
				onRequestUpgrade: (...args) => {
					transport = args[3];
					return handler.onRequestUpgrade?.(...args);
				},
				onResponseStart: (...args) => handler.onResponseStart?.(...args),
				onResponseData: (...args) => handler.onResponseData?.(...args),
				onResponseEnd: (...args) => handler.onResponseEnd?.(...args),
				onResponseError: (...args) => handler.onResponseError?.(...args),
				onResponseStarted: () => handler.onResponseStarted?.(),
				onBodySent: (...args) => handler.onBodySent?.(...args),
				onRequestSent: () => handler.onRequestSent?.(),
			}),
	);
	let socket: WebSocket;
	try {
		socket = new WebSocket(url, {
			headers: Object.fromEntries(headers),
			dispatcher,
		});
	} catch (error) {
		await owner.destroy();
		throw error;
	}
	let closeTimer: ReturnType<typeof setTimeout> | undefined;
	const closed = new Promise<void>((resolve, reject) => {
		socket.addEventListener(
			"close",
			() => {
				clearTimeout(closeTimer);
				void owner.close().then(resolve, reject);
			},
			{ once: true },
		);
	});
	void closed.catch(() => {});
	const terminate = () => {
		if (transport) transport.destroy();
		else void owner.destroy().catch(() => {});
	};
	const owned: WebSocketLike = {
		get readyState() {
			return socket.readyState;
		},
		closed,
		send: (data) => socket.send(data),
		addEventListener: (type, listener) =>
			socket.addEventListener(type, listener),
		removeEventListener: (type, listener) =>
			socket.removeEventListener(type, listener),
		close(code, reason) {
			socket.close(code, reason);
			if (socket.readyState !== WebSocket.CLOSED && !closeTimer)
				closeTimer = setTimeout(terminate, 2_000);
		},
	};
	try {
		await new Promise<void>((resolve, reject) => {
			const finish = (error?: Error) => {
				clearTimeout(timer);
				signal.removeEventListener("abort", abort);
				socket.removeEventListener("open", open);
				socket.removeEventListener("error", failed);
				if (error) reject(error);
				else resolve();
			};
			const open = () => finish();
			const failed = (event: unknown) => finish(extractWebSocketError(event));
			const abort = () =>
				finish(new Error("Codex dictation startup cancelled"));
			const timer = setTimeout(
				() => finish(new Error("Codex dictation connection timed out")),
				timeoutMs,
			);
			socket.addEventListener("open", open);
			socket.addEventListener("error", failed);
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) abort();
		});
		return owned;
	} catch (error) {
		socket.close();
		terminate();
		await closed;
		throw error;
	}
}
