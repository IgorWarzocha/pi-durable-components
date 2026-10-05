import { DEFAULT_WEBSOCKET_CLOSE_TIMEOUT_MS } from "./constants.ts";
import type { WebSocketLike } from "./types.ts";

type WorkerSocket = WebSocketLike & { accept(): void };

/** Workers authenticates an outbound upgrade through fetch, not a browser constructor. */
export async function connectWorkerWebSocket(
	url: string,
	headers: Headers,
	signal: AbortSignal | undefined,
	timeoutMs: number,
	onCreated?: (socket: WebSocketLike) => void,
): Promise<WebSocketLike> {
	const controller = new AbortController();
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let timeoutError: Error | undefined;
	let socket: WebSocketLike | undefined;
	const abort = () => controller.abort(signal?.reason);
	signal?.addEventListener("abort", abort, { once: true });
	if (signal?.aborted) abort();
	if (timeoutMs > 0)
		timeout = setTimeout(() => {
			timeoutError = new Error(
				`WebSocket connect timeout after ${timeoutMs}ms`,
			);
			controller.abort(timeoutError);
		}, timeoutMs);
	const requestHeaders = new Headers(headers);
	requestHeaders.set("Upgrade", "websocket");
	try {
		controller.signal.throwIfAborted();
		const response = await fetch(
			url.replace(/^wss:/, "https:").replace(/^ws:/, "http:"),
			{ headers: requestHeaders, signal: controller.signal },
		);
		const candidate = (response as Response & { webSocket?: WorkerSocket })
			.webSocket;
		if (response.status !== 101 || !candidate) {
			await response.body?.cancel();
			throw Object.assign(
				new Error(`WebSocket upgrade HTTP ${response.status}`),
				{ status: response.status },
			);
		}
		let closeTimer: ReturnType<typeof setTimeout> | undefined;
		let resolveClosed!: () => void;
		let rejectClosed!: (error: Error) => void;
		const closed = new Promise<void>((resolve, reject) => {
			resolveClosed = resolve;
			rejectClosed = reject;
		});
		candidate.addEventListener("close", () => {
			if (closeTimer) clearTimeout(closeTimer);
			resolveClosed();
		});
		socket = {
			get readyState() {
				return candidate.readyState;
			},
			closed,
			send: (data) => candidate.send(data),
			addEventListener: (type, listener) =>
				candidate.addEventListener(type, listener),
			removeEventListener: (type, listener) =>
				candidate.removeEventListener(type, listener),
			close(code, reason) {
				candidate.close(code, reason);
				if (!closeTimer && candidate.readyState !== 3)
					closeTimer = setTimeout(
						() => rejectClosed(new Error("Worker WebSocket close timed out")),
						DEFAULT_WEBSOCKET_CLOSE_TIMEOUT_MS,
					);
			},
		};
		// Ownership and close observers must exist before accept can emit events.
		onCreated?.(socket);
		candidate.accept();
		controller.signal.throwIfAborted();
		return socket;
	} catch (error) {
		socket?.close(1000, "connect_error");
		throw timeoutError ?? error;
	} finally {
		if (timeout) clearTimeout(timeout);
		signal?.removeEventListener("abort", abort);
	}
}
