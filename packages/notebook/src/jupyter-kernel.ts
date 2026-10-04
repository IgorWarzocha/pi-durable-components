// Adapted from pi-codex-conversion at b2006db9def12c373ae48e70044d30f7d6b7e34f, MIT. See ../NOTICE.
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import {
	createJupyterConnectionFile,
	type JupyterConnectionInfo,
} from "./jupyter-connection.ts";
import { JupyterExecution } from "./jupyter-execution.ts";
import type { KernelExecutionResult } from "./jupyter-output.ts";
import { JupyterShellChannel } from "./jupyter-shell.ts";
import { JupyterSocket } from "./jupyter-socket.ts";
import {
	createJupyterMessage,
	decodeJupyterMessage,
	encodeJupyterMessage,
} from "./jupyter-wire.ts";
import type { RuntimeContentItem } from "./runtime-contract.ts";

const STARTUP_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 8_000;
const SHUTDOWN_GRACE_MS = 1_500;
const MAX_STDERR_CHARS = 16_384;

export type { KernelExecutionResult } from "./jupyter-output.ts";

export class DenoJupyterKernel {
	private readonly deno: string;
	private readonly execution: JupyterExecution;
	private readonly shellChannel: JupyterShellChannel;
	private readonly env: NodeJS.ProcessEnv;
	private readonly maxHeapMiB: number;
	private readonly onFailure:
		| ((kernel: DenoJupyterKernel, error: Error) => void)
		| undefined;
	private readonly session = randomUUID();
	private process: ChildProcess | undefined;
	private tempDir: string | undefined;
	private connection: JupyterConnectionInfo | undefined;
	private control: JupyterSocket | undefined;
	private iopub: JupyterSocket | undefined;
	private shellPump: Promise<void> | undefined;
	private iopubPump: Promise<void> | undefined;
	private startup: Promise<void> | undefined;
	private stderr = "";
	private terminalFailure: Error | undefined;

	constructor(options: {
		deno: string;
		maxHeapMiB: number;
		env?: NodeJS.ProcessEnv | undefined;
		onFailure?: ((kernel: DenoJupyterKernel, error: Error) => void) | undefined;
	}) {
		this.deno = options.deno;
		this.env = options.env ?? process.env;
		this.maxHeapMiB = options.maxHeapMiB;
		this.onFailure = options.onFailure;
		this.shellChannel = new JupyterShellChannel(
			this.session,
			() => this.stderr,
			(error) => this.failKernel(error),
		);
		this.execution = new JupyterExecution(this.session, {
			deno: this.deno,
			env: this.env,
			start: (signal) => this.start(signal),
			sendShellRequest: (request, timeoutMs, requestType) =>
				this.shellChannel.send(request, timeoutMs, requestType),
			interrupt: () => this.interrupt(),
			failKernel: (error) => this.failKernel(error),
		});
	}

	async start(signal?: AbortSignal): Promise<void> {
		if (this.terminalFailure) {
			throw new Error(
				`Deno Jupyter kernel is unavailable: ${this.terminalFailure.message}`,
				{ cause: this.terminalFailure },
			);
		}
		if (!this.startup)
			this.startup = this.startInner(signal).catch((error) => {
				this.startup = undefined;
				this.dispose();
				throw error;
			});
		return this.startup;
	}

	async execute(
		code: string,
		options: {
			cellSource?: string | undefined;
			signal?: AbortSignal | undefined;
			onOutput?: ((item: RuntimeContentItem) => void) | undefined;
			interruptOnAbort?: boolean | undefined;
		} = {},
	): Promise<KernelExecutionResult> {
		return this.execution.execute(code, options);
	}

	async complete(
		code = "",
		cursorPosition = code.length,
		signal?: AbortSignal,
	): Promise<string[]> {
		await this.start(signal);
		signal?.throwIfAborted();
		if (this.execution.isActive())
			throw new Error(
				"Cannot request notebook completions while a cell is active",
			);
		const response = await this.shellChannel.request(
			"complete_request",
			{
				code,
				cursor_pos: cursorPosition,
			},
			REQUEST_TIMEOUT_MS,
			signal,
		);
		const matches = response.content["matches"];
		return Array.isArray(matches)
			? matches.filter((value): value is string => typeof value === "string")
			: [];
	}

	async interrupt(): Promise<void> {
		if (!this.control || !this.connection) return;
		const message = createJupyterMessage("interrupt_request", {}, this.session);
		await this.control.send(encodeJupyterMessage(message, this.connection.key));
	}

	async shutdown(): Promise<void> {
		const process = this.process;
		const pumps = [this.shellPump, this.iopubPump].filter(
			(pump): pump is Promise<void> => Boolean(pump),
		);
		if (this.control && this.connection) {
			try {
				const message = createJupyterMessage(
					"shutdown_request",
					{ restart: false },
					this.session,
				);
				await withTimeout(
					this.control.send(encodeJupyterMessage(message, this.connection.key)),
					SHUTDOWN_GRACE_MS,
					() =>
						new Error(
							`Deno Jupyter could not send shutdown_request within ${SHUTDOWN_GRACE_MS}ms`,
						),
				);
			} catch {
				// Process termination below is the fallback.
			}
		}
		if (process?.exitCode === null && process.signalCode === null) {
			await waitForProcessExit(process, SHUTDOWN_GRACE_MS);
		}
		if (process?.exitCode === null && process.signalCode === null) {
			process.kill("SIGTERM");
			await waitForProcessExit(process, SHUTDOWN_GRACE_MS);
		}
		if (process?.exitCode === null && process.signalCode === null) {
			process.kill("SIGKILL");
			await waitForProcessExit(process, SHUTDOWN_GRACE_MS);
		}
		this.dispose();
		await withTimeout(
			Promise.allSettled(pumps),
			SHUTDOWN_GRACE_MS,
			() =>
				new Error(
					`Deno Jupyter socket pumps did not stop within ${SHUTDOWN_GRACE_MS}ms`,
				),
		).catch(() => undefined);
		this.shellPump = undefined;
		this.iopubPump = undefined;
	}

	private async startInner(signal?: AbortSignal): Promise<void> {
		if (this.process && this.connection) return;
		signal?.throwIfAborted();
		const { info, path, dir } = await createJupyterConnectionFile();
		this.tempDir = dir;
		const child = spawn(this.deno, ["jupyter", "--kernel", "--conn", path], {
			cwd: dir,
			env: {
				...this.env,
				DENO_NO_PACKAGE_JSON: "1",
				DENO_V8_FLAGS: [
					this.env["DENO_V8_FLAGS"],
					`--max-old-space-size=${this.maxHeapMiB}`,
				]
					.filter(Boolean)
					.join(" "),
			},
			stdio: ["ignore", "ignore", "pipe"],
		});
		this.process = child;
		child.stderr?.on("data", (chunk: Buffer) => {
			this.stderr = `${this.stderr}${chunk.toString()}`.slice(
				-MAX_STDERR_CHARS,
			);
		});
		child.on("error", (error) =>
			this.failKernel(
				new Error(`Deno Jupyter process failed: ${error.message}`),
			),
		);
		child.on("exit", (code, childSignal) => {
			if (this.process !== child) return;
			this.failKernel(
				new Error(
					`Deno Jupyter exited unexpectedly (code=${code}, signal=${childSignal})${this.stderr ? `\n${this.stderr}` : ""}`,
				),
			);
		});
		const connection = info;
		this.connection = connection;
		const shell = new JupyterSocket("DEALER", connection.shell_port);
		this.shellChannel.attach(shell, connection);
		this.control = new JupyterSocket("DEALER", connection.control_port);
		this.iopub = new JupyterSocket("SUB", connection.iopub_port);
		await Promise.all([
			shell.connect(signal),
			this.control.connect(signal),
			this.iopub.connect(signal),
		]);
		this.shellPump = this.shellChannel.pump(shell, connection);
		let markIopubReady!: () => void;
		const iopubReady = new Promise<void>((resolve) => {
			markIopubReady = resolve;
		});
		this.iopubPump = this.runIopubPump(markIopubReady);
		await this.waitForKernelReady(iopubReady, signal);
	}

	private async waitForKernelReady(
		iopubReady: Promise<void>,
		signal?: AbortSignal,
	): Promise<void> {
		const deadline = Date.now() + STARTUP_TIMEOUT_MS;
		while (true) {
			signal?.throwIfAborted();
			const remaining = deadline - Date.now();
			if (remaining <= 0) {
				throw new Error(
					`Deno Jupyter IOPub did not become ready within ${STARTUP_TIMEOUT_MS}ms${this.stderr ? `\n${this.stderr}` : ""}`,
				);
			}
			await this.shellChannel.request(
				"kernel_info_request",
				{},
				remaining,
				signal,
			);
			const ready = await Promise.race([
				iopubReady.then(() => true),
				sleep(Math.min(100, remaining), false, signal ? { signal } : undefined),
			]);
			if (ready) return;
		}
	}

	private async runIopubPump(markReady?: () => void): Promise<void> {
		const socket = this.iopub;
		const connection = this.connection;
		if (!socket || !connection) return;
		try {
			for await (const frames of socket) {
				const message = decodeJupyterMessage(
					[...frames] as Buffer[],
					connection.key,
				);
				if (message) {
					markReady?.();
					markReady = undefined;
					this.execution.accept(message);
				}
			}
		} catch (error) {
			if (this.iopub === socket)
				this.failKernel(
					error instanceof Error ? error : new Error(String(error)),
				);
		}
	}

	private failKernel(error: Error): void {
		if (!this.terminalFailure) {
			this.terminalFailure = error;
			this.onFailure?.(this, error);
		}
		this.execution.reject(error);
		this.dispose();
	}

	private dispose(): void {
		const child = this.process;
		this.process = undefined;
		if (child?.exitCode === null && child.signalCode === null) {
			child.kill("SIGTERM");
			const killTimer = setTimeout(() => {
				if (child.exitCode === null && child.signalCode === null)
					child.kill("SIGKILL");
			}, SHUTDOWN_GRACE_MS);
			killTimer.unref?.();
			child.once("exit", () => clearTimeout(killTimer));
		}
		this.shellChannel.close();
		this.control?.close();
		this.iopub?.close();
		this.control = undefined;
		this.iopub = undefined;
		this.connection = undefined;
		this.startup = undefined;
		if (this.tempDir) rmSync(this.tempDir, { recursive: true, force: true });
		this.tempDir = undefined;
	}
}

function waitForProcessExit(
	process: ChildProcess,
	timeoutMs: number,
): Promise<void> {
	if (process.exitCode !== null || process.signalCode !== null)
		return Promise.resolve();
	return new Promise((resolve) => {
		const timer = setTimeout(finish, timeoutMs);
		const exited = () => finish();
		function finish() {
			clearTimeout(timer);
			process.off("exit", exited);
			resolve();
		}
		process.once("exit", exited);
	});
}

async function withTimeout<T>(
	pending: Promise<T>,
	timeoutMs: number,
	timeoutError: () => Error,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(timeoutError()), timeoutMs);
		timer.unref?.();
	});
	try {
		return await Promise.race([pending, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
