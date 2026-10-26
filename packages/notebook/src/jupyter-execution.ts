// Adapted from pi-codex-conversion at b2006db9def12c373ae48e70044d30f7d6b7e34f, MIT. See ../NOTICE.
import { randomUUID } from "node:crypto";
import { diagnoseDenoSyntax } from "./deno-syntax-diagnostics.ts";
import {
	type ActiveKernelExecution,
	applyExecuteReplyError,
	applyKernelOutput,
	finishKernelExecution,
	type KernelExecutionResult,
	OUTPUT_DRAIN_MESSAGE,
} from "./jupyter-output.ts";
import { createJupyterMessage, type JupyterMessage } from "./jupyter-wire.ts";
import type { RuntimeContentItem } from "./runtime-contract.ts";
import { withNotebookRecoveryGuidance } from "./runtime-health.ts";

const REQUEST_TIMEOUT_MS = 8_000;
const SHUTDOWN_GRACE_MS = 1_500;
interface JupyterExecutionHost {
	deno: string;
	env: NodeJS.ProcessEnv;
	start(signal?: AbortSignal): Promise<void>;
	sendShellRequest(
		request: JupyterMessage,
		timeoutMs?: number,
		requestType?: string,
	): Promise<JupyterMessage>;
	interrupt(): Promise<void>;
	failKernel(error: Error): void;
}
/** Collection spans the cell reply/idle and a FIFO output marker's reply/idle. */
export class JupyterExecution {
	private active: ActiveKernelExecution | undefined;
	private readonly session: string;
	private readonly host: JupyterExecutionHost;
	constructor(session: string, host: JupyterExecutionHost) {
		this.session = session;
		this.host = host;
	}
	isActive(): boolean {
		return this.active !== undefined;
	}
	reject(error: Error): void {
		const active = this.active;
		this.active = undefined;
		active?.reject(error);
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
		await this.host.start(options.signal);
		options.signal?.throwIfAborted();
		if (this.active)
			throw new Error("Notebook kernel already has an active cell");
		const message = createJupyterMessage(
			"execute_request",
			{
				code,
				silent: false,
				store_history: true,
				user_expressions: {},
				allow_stdin: false,
				stop_on_error: true,
			},
			this.session,
		);
		let resolve!: () => void;
		let reject!: (error: Error) => void;
		const completion = new Promise<void>((done, fail) => {
			resolve = done;
			reject = fail;
		});
		const execution: ActiveKernelExecution = {
			requestId: message.header.msg_id,
			items: [],
			outputChars: 0,
			outputTruncated: false,
			status: "ok",
			...(options.onOutput ? { onOutput: options.onOutput } : {}),
			resolve,
			reject,
		};
		let abortTimer: ReturnType<typeof setTimeout> | undefined;
		let finished = false;
		const abort = () => {
			if (options.interruptOnAbort !== false)
				void this.host.interrupt().catch(() => undefined);
			abortTimer = setTimeout(() => {
				if (!finished) {
					this.host.failKernel(
						options.signal?.reason instanceof Error
							? options.signal.reason
							: new Error(
									"Deno Jupyter execution did not stop after cancellation",
								),
					);
				}
			}, SHUTDOWN_GRACE_MS);
			abortTimer.unref?.();
		};
		options.signal?.addEventListener("abort", abort, { once: true });
		this.active = execution;
		try {
			const completionState = completion.then(() => ({
				kind: "completion" as const,
			}));
			const replyState = this.host
				.sendShellRequest(message, undefined, "execute_request")
				.then((reply) => ({ kind: "reply" as const, reply }));
			let reply: JupyterMessage;
			try {
				const first = await Promise.race([completionState, replyState]);
				if (first.kind === "completion") {
					reply = (
						await withTimeout(
							replyState,
							REQUEST_TIMEOUT_MS,
							() =>
								new Error(
									withNotebookRecoveryGuidance(
										`Notebook execution did not finish within ${REQUEST_TIMEOUT_MS}ms`,
									),
								),
						)
					).reply;
				} else {
					reply = first.reply;
					await withTimeout(
						completionState,
						REQUEST_TIMEOUT_MS,
						() =>
							new Error(
								withNotebookRecoveryGuidance(
									`Notebook execution did not finish within ${REQUEST_TIMEOUT_MS}ms`,
								),
							),
					);
				}
			} catch (error) {
				this.host.failKernel(
					error instanceof Error ? error : new Error(String(error)),
				);
				throw error;
			}
			if (reply.header.msg_type !== "execute_reply") {
				throw new Error(
					withNotebookRecoveryGuidance(
						"Notebook execution returned an unexpected response",
					),
				);
			}
			await this.drainOutput(execution);
			const replied = applyExecuteReplyError(
				finishKernelExecution(execution),
				reply,
			);
			if (options.signal?.aborted) {
				if (options.interruptOnAbort !== false)
					this.host.failKernel(new Error("Deno Jupyter execution was aborted"));
				return { ...replied, status: "aborted" };
			}
			if (
				replied.errorName === "Error" &&
				replied.errorValue === "Execution failed" &&
				replied.errorText === "Error: Execution failed"
			) {
				const diagnostic = await diagnoseDenoSyntax(
					this.host.deno,
					code,
					this.host.env,
					options.cellSource,
				);
				if (diagnostic) {
					return {
						...replied,
						errorName: "SyntaxError",
						errorValue: diagnostic
							.split("\n")[0]!
							.replace(/^SyntaxError:\s*/, ""),
						errorText: diagnostic,
					};
				}
			}
			return replied;
		} finally {
			finished = true;
			if (this.active === execution) this.active = undefined;
			if (abortTimer) clearTimeout(abortTimer);
			options.signal?.removeEventListener("abort", abort);
		}
	}

	accept(message: JupyterMessage): void {
		const execution = this.active;
		if (
			!execution ||
			(message.parent_header["msg_id"] !== execution.requestId &&
				message.parent_header["msg_id"] !== execution.drain?.requestId)
		)
			return;
		if (applyKernelOutput(message, execution) === "idle") {
			execution.resolve();
		}
	}

	private async drainOutput(execution: ActiveKernelExecution): Promise<void> {
		const marker = randomUUID();
		const message = createJupyterMessage(
			"execute_request",
			{
				code: `globalThis.Deno.jupyter.broadcast(${JSON.stringify(OUTPUT_DRAIN_MESSAGE)}, { marker: ${JSON.stringify(marker)} });`,
				silent: true,
				store_history: false,
				user_expressions: {},
				allow_stdin: false,
				stop_on_error: true,
			},
			this.session,
		);
		// Deno idle can precede its FIFO output drainer and queued output can
		// acquire the drain's parent ID. Keep the original collector for both.
		execution.drain = {
			requestId: message.header.msg_id,
			marker,
			idle: false,
			seen: false,
		};
		const completion = new Promise<void>((resolve, reject) => {
			execution.resolve = resolve;
			execution.reject = reject;
		});
		const timeoutError = new Error("Notebook output collection timed out");
		try {
			await withTimeout(
				Promise.all([
					this.host
						.sendShellRequest(message, REQUEST_TIMEOUT_MS, "output drain")
						.then((reply) => {
							if (
								reply.header.msg_type !== "execute_reply" ||
								reply.content["status"] !== "ok"
							) {
								throw new Error("Unexpected output drain reply");
							}
						}),
					completion,
				]),
				REQUEST_TIMEOUT_MS,
				() => timeoutError,
			);
		} catch (error) {
			const failure = new Error(
				withNotebookRecoveryGuidance(
					`Notebook output collection ${error === timeoutError ? "timed out" : "failed"}; the runtime is unavailable`,
				),
				{ cause: error },
			);
			this.host.failKernel(failure);
			throw failure;
		}
	}
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
