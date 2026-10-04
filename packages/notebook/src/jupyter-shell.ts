// Adapted from pi-codex-conversion at b2006db9def12c373ae48e70044d30f7d6b7e34f, MIT. See ../NOTICE.
import type { JupyterConnectionInfo } from "./jupyter-connection.ts";
import type { JupyterSocket } from "./jupyter-socket.ts";
import {
	createJupyterMessage,
	decodeJupyterMessage,
	encodeJupyterMessage,
	type JupyterMessage,
} from "./jupyter-wire.ts";

const REQUEST_TIMEOUT_MS = 8_000;
interface ShellReplyWaiter {
	resolve(message: JupyterMessage): void;
	reject(error: Error): void;
	timer?: ReturnType<typeof setTimeout> | undefined;
	abort?: (() => void) | undefined;
}

/** Correlation, request timeouts and disconnect settlement belong to the shell channel. */
export class JupyterShellChannel {
	private shell: JupyterSocket | undefined;
	private connection: JupyterConnectionInfo | undefined;
	private readonly shellReplies = new Map<string, ShellReplyWaiter>();
	private readonly session: string;
	private readonly stderr: () => string;
	private readonly onFailure: (error: Error) => void;
	constructor(
		session: string,
		stderr: () => string,
		onFailure: (error: Error) => void,
	) {
		this.session = session;
		this.stderr = stderr;
		this.onFailure = onFailure;
	}
	attach(shell: JupyterSocket, connection: JupyterConnectionInfo): void {
		this.shell = shell;
		this.connection = connection;
	}
	close(): void {
		const shell = this.shell;
		this.shell = undefined;
		for (const waiter of this.shellReplies.values()) {
			if (waiter.timer) clearTimeout(waiter.timer);
			waiter.reject(new Error("Deno Jupyter shell disconnected"));
		}
		this.shellReplies.clear();
		shell?.close();
		this.connection = undefined;
	}
	async request(
		type: string,
		content: Record<string, unknown>,
		timeoutMs = REQUEST_TIMEOUT_MS,
		signal?: AbortSignal,
	): Promise<JupyterMessage> {
		const shell = this.shell;
		const connection = this.connection;
		if (!shell || !connection)
			throw new Error("Deno Jupyter shell is not connected");
		const request = createJupyterMessage(type, content, this.session);
		return this.send(request, timeoutMs, type, signal);
	}

	async send(
		request: JupyterMessage,
		timeoutMs?: number,
		requestType = "request",
		signal?: AbortSignal,
	): Promise<JupyterMessage> {
		const shell = this.shell;
		const connection = this.connection;
		if (!shell || !connection)
			throw new Error("Deno Jupyter shell is not connected");
		const requestId = request.header.msg_id;
		if (this.shellReplies.has(requestId))
			throw new Error(`Duplicate Deno Jupyter shell request: ${requestId}`);
		let waiter!: ShellReplyWaiter;
		const reply = new Promise<JupyterMessage>((resolve, reject) => {
			waiter = { resolve, reject };
		});
		if (timeoutMs !== undefined) {
			waiter.timer = setTimeout(() => {
				if (this.shellReplies.get(requestId) !== waiter) return;
				this.shellReplies.delete(requestId);
				waiter.reject(
					new Error(
						`Deno Jupyter did not answer ${requestType} within ${timeoutMs}ms${this.stderr() ? `\n${this.stderr()}` : ""}`,
					),
				);
			}, timeoutMs);
		}
		if (signal) {
			waiter.abort = () => {
				if (this.shellReplies.get(requestId) !== waiter) return;
				this.shellReplies.delete(requestId);
				if (waiter.timer) clearTimeout(waiter.timer);
				waiter.reject(
					signal.reason instanceof Error
						? signal.reason
						: new Error("Deno Jupyter request aborted"),
				);
			};
			signal.addEventListener("abort", waiter.abort, { once: true });
		}
		this.shellReplies.set(requestId, waiter);
		try {
			signal?.throwIfAborted();
			const [, response] = await Promise.all([
				shell.send(encodeJupyterMessage(request, connection.key)),
				reply,
			]);
			return response;
		} catch (error) {
			if (this.shellReplies.get(requestId) === waiter)
				this.shellReplies.delete(requestId);
			if (waiter.timer) clearTimeout(waiter.timer);
			throw error;
		} finally {
			if (waiter.abort) signal?.removeEventListener("abort", waiter.abort);
		}
	}

	async pump(
		socket: JupyterSocket,
		connection: JupyterConnectionInfo,
	): Promise<void> {
		try {
			for await (const frames of socket) {
				const message = decodeJupyterMessage(
					[...frames] as Buffer[],
					connection.key,
				);
				const requestId = message?.parent_header["msg_id"];
				if (typeof requestId !== "string") continue;
				const waiter = this.shellReplies.get(requestId);
				if (!waiter) continue;
				this.shellReplies.delete(requestId);
				if (waiter.timer) clearTimeout(waiter.timer);
				waiter.resolve(message!);
			}
		} catch (error) {
			if (this.shell === socket)
				this.onFailure(
					error instanceof Error ? error : new Error(String(error)),
				);
		}
	}
}
