import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { deferred } from "../deferred.ts";
import type { GippityAudioHost } from "../host.ts";
import {
	BoundedJsonlReader,
	parseVoiceHelperEvent,
	type VoiceHelperCommand,
	type VoiceHelperEvent,
} from "./helper-protocol.ts";

export type {
	VoiceHelperCommand,
	VoiceHelperEvent,
} from "./helper-protocol.ts";

const MAX_HELPER_LINE_BYTES = 512 * 1024;
const READY_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 2_000;
const MAX_HELPER_STDIN_BYTES = 512 * 1024;

export class VoiceHelperClient {
	private readonly host: GippityAudioHost;
	constructor(host: GippityAudioHost) {
		this.host = host;
	}
	private child: ChildProcessWithoutNullStreams | undefined;
	private listeners = new Set<(event: VoiceHelperEvent) => void>();
	private exitListeners = new Set<(error: Error) => void>();
	private stdinFailures = new WeakSet<ChildProcessWithoutNullStreams>();
	private helperProtocolVersion: number | undefined;
	private closing: Promise<void> | undefined;

	get protocolVersion(): number | undefined {
		return this.helperProtocolVersion;
	}

	onEvent(listener: (event: VoiceHelperEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	onExit(listener: (error: Error) => void): () => void {
		this.exitListeners.add(listener);
		return () => this.exitListeners.delete(listener);
	}

	async start(): Promise<void> {
		if (this.closing) throw new Error("Audio helper is closing or closed");
		if (this.child) return;
		const child = this.host.launch();
		this.child = child;
		const ready = deferred<void>();
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr = `${stderr}${chunk}`.slice(-8_192);
		});
		child.stdin.on("error", (error) => {
			ready.reject(error);
			this.handleStdinError(child, error);
		});
		const lines = new BoundedJsonlReader(
			MAX_HELPER_LINE_BYTES,
			(line) => {
				try {
					const event = parseVoiceHelperEvent(JSON.parse(line));
					if (event.type === "ready") {
						if (
							event.version === 2 ||
							event.version === 3 ||
							event.version === 4 ||
							event.version === 5 ||
							event.version === 6
						) {
							this.helperProtocolVersion = event.version;
							ready.resolve();
						} else
							ready.reject(
								new Error(
									`Unsupported Codex voice helper protocol ${event.version}`,
								),
							);
					}
					for (const listener of this.listeners) listener(event);
				} catch (error) {
					this.fail(error instanceof Error ? error : new Error(String(error)));
				}
			},
			() => {
				const error = new Error(
					"Codex voice helper emitted an oversized event",
				);
				ready.reject(error);
				this.fail(error);
				child.stdout.destroy();
				void this.close().catch((failure: unknown) =>
					this.fail(
						failure instanceof Error ? failure : new Error(String(failure)),
					),
				);
			},
		);
		child.stdout.on("data", (chunk: Buffer) => lines.push(chunk));
		child.stdout.once("end", () => lines.end());
		child.once("error", (error) => {
			ready.reject(error);
			if (!this.stdinFailures.has(child)) this.fail(error);
		});
		child.once("exit", (code, signal) => {
			const detail = stderr.trim();
			const error = new Error(
				`Codex voice helper exited (${signal ?? code ?? "unknown"})${detail ? `: ${detail}` : ""}`,
			);
			ready.reject(error);
			if (this.child === child) {
				this.child = undefined;
				this.helperProtocolVersion = undefined;
			}
			if (!this.stdinFailures.has(child)) this.fail(error);
		});
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				ready.promise,
				new Promise<void>((_resolve, reject) => {
					timeout = setTimeout(
						() =>
							reject(
								new Error(
									`Codex voice helper did not become ready within ${READY_TIMEOUT_MS}ms`,
								),
							),
						READY_TIMEOUT_MS,
					);
				}),
			]);
		} catch (error) {
			await this.close();
			throw error;
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	}

	send(command: VoiceHelperCommand): void {
		const child = this.child;
		if (!child?.stdin.writable)
			throw new Error("Codex voice helper is not running");
		const line = `${JSON.stringify(command)}\n`;
		if (
			child.stdin.writableLength + Buffer.byteLength(line) >
			MAX_HELPER_STDIN_BYTES
		) {
			const error = new Error("Codex voice helper input is backpressured");
			this.handleStdinError(child, error);
			throw error;
		}
		try {
			child.stdin.write(line, (error) => {
				if (error) this.handleStdinError(child, error);
			});
		} catch (error) {
			const writeError =
				error instanceof Error ? error : new Error(String(error));
			this.handleStdinError(child, writeError);
			throw writeError;
		}
	}

	async stop(): Promise<void> {
		if (!this.child) return;
		const stopped = deferred<void>();
		const removeEvent = this.onEvent((event) => {
			if (event.type === "stopped") stopped.resolve();
			else if (event.type === "error") stopped.reject(new Error(event.message));
		});
		const removeExit = this.onExit((error) => stopped.reject(error));
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			this.send({ type: "stop" });
			await Promise.race([
				stopped.promise,
				new Promise<void>((_resolve, reject) => {
					timeout = setTimeout(
						() => reject(new Error("Codex voice helper did not stop")),
						STOP_TIMEOUT_MS,
					);
				}),
			]);
		} finally {
			if (timeout) clearTimeout(timeout);
			removeEvent();
			removeExit();
		}
	}

	close(): Promise<void> {
		this.closing ??= this.closeProcess();
		return this.closing;
	}

	private async closeProcess(): Promise<void> {
		const child = this.child;
		if (!child) return;
		if (child.stdin.writable)
			child.stdin.end(`${JSON.stringify({ type: "shutdown" })}\n`);
		if (await waitForExit(child, 2_000)) return;
		child.kill();
		if (await waitForExit(child, 1_000)) return;
		child.kill("SIGKILL");
		if (!(await waitForExit(child, 1_000)))
			throw new Error("Native audio process termination is uncertain");
	}

	private fail(error: Error): void {
		for (const listener of this.exitListeners) listener(error);
	}

	private handleStdinError(
		child: ChildProcessWithoutNullStreams,
		error: Error,
	): void {
		if (this.stdinFailures.has(child)) return;
		this.stdinFailures.add(child);
		if (this.child !== child) return;
		child.kill();
		this.fail(error);
	}
}

function waitForExit(
	child: ChildProcessWithoutNullStreams,
	timeoutMs: number,
): Promise<boolean> {
	if (child.exitCode !== null || child.signalCode !== null)
		return Promise.resolve(true);
	return new Promise((resolve) => {
		const timeout = setTimeout(() => {
			child.off("exit", onExit);
			resolve(false);
		}, timeoutMs);
		const onExit = () => {
			clearTimeout(timeout);
			resolve(true);
		};
		child.once("exit", onExit);
	});
}
