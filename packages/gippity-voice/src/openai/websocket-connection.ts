import { ProxyAgent, WebSocket } from "undici";
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
	const dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
	const socket = new WebSocket(url, {
		headers: Object.fromEntries(headers),
		...(dispatcher ? { dispatcher } : {}),
	});
	const closeDispatcher = () => {
		void dispatcher?.close();
	};
	socket.addEventListener("close", closeDispatcher, { once: true });
	socket.addEventListener("error", closeDispatcher, { once: true });
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
		return socket;
	} catch (error) {
		socket.close();
		await dispatcher?.close();
		throw error;
	}
}
