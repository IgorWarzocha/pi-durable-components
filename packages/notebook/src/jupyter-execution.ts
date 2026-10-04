// Adapted from pi-codex-conversion at b2006db9def12c373ae48e70044d30f7d6b7e34f, MIT. See ../NOTICE.
import { diagnoseDenoSyntax } from "./deno-syntax-diagnostics.ts";
import {
	type ActiveKernelExecution,
	applyExecuteReplyError,
	applyKernelOutput,
	finishKernelExecution,
	type KernelExecutionResult,
} from "./jupyter-output.ts";
import { createJupyterMessage, type JupyterMessage } from "./jupyter-wire.ts";
import type { RuntimeContentItem } from "./runtime-contract.ts";

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
/** A cell completes only after both execute_reply and matching IOPub idle. */
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
		let resolve!: (result: KernelExecutionResult) => void;
		let reject!: (error: Error) => void;
		const completion = new Promise<KernelExecutionResult>((done, fail) => {
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
			const completionState = completion.then((result) => ({
				kind: "completion" as const,
				result,
			}));
			const replyState = this.host
				.sendShellRequest(message, undefined, "execute_request")
				.then((reply) => ({ kind: "reply" as const, reply }));
			let result: KernelExecutionResult;
			let reply: JupyterMessage;
			try {
				const first = await Promise.race([completionState, replyState]);
				if (first.kind === "completion") {
					result = first.result;
					reply = (
						await withTimeout(
							replyState,
							REQUEST_TIMEOUT_MS,
							() =>
								new Error(
									`Deno Jupyter did not answer execute_request after the cell became idle within ${REQUEST_TIMEOUT_MS}ms`,
								),
						)
					).reply;
				} else {
					reply = first.reply;
					result = (
						await withTimeout(
							completionState,
							REQUEST_TIMEOUT_MS,
							() =>
								new Error(
									`Deno Jupyter did not become idle after execute_reply within ${REQUEST_TIMEOUT_MS}ms`,
								),
						)
					).result;
				}
			} catch (error) {
				this.host.failKernel(
					error instanceof Error ? error : new Error(String(error)),
				);
				throw error;
			}
			if (reply.header.msg_type !== "execute_reply") {
				throw new Error(
					`Deno Jupyter returned ${reply.header.msg_type} for execute_request`,
				);
			}
			const replied = applyExecuteReplyError(result, reply);
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
		} catch (error) {
			if (this.active === execution) this.active = undefined;
			throw error;
		} finally {
			finished = true;
			if (abortTimer) clearTimeout(abortTimer);
			options.signal?.removeEventListener("abort", abort);
		}
	}

	accept(message: JupyterMessage): void {
		const execution = this.active;
		if (!execution || message.parent_header["msg_id"] !== execution.requestId)
			return;
		if (applyKernelOutput(message, execution) === "idle") {
			this.active = undefined;
			execution.resolve(finishKernelExecution(execution));
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
