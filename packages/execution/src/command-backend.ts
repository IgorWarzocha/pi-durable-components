// Direct process algorithms adapted from pi-codex-conversion custom-tool-runner.ts, MIT. See ../NOTICE.
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export interface CustomCommandRequest {
	command: string;
	args: readonly string[];
	cwd: string;
	stdin?: string;
}

/** Direct command capability. Implementations must enforce the output and cancellation contract. */
export interface CustomCommandBackend {
	readonly environmentId: string;
	readonly platform: string;
	readonly javascriptRuntime: string;
	/** No shell expansion. Return trimmed stdout, stderr when empty, or '(no output)'.
	 * Cap combined bytes at 50 KiB and reject nonzero exits. Cancellation must drain the owned process group. */
	run(request: CustomCommandRequest, signal?: AbortSignal): Promise<string>;
}

export interface NodeCommandBackendOptions {
	/** Explicitly verified local process namespace. Must match the invocation environment. */
	environmentId: string;
	env?: NodeJS.ProcessEnv;
	javascriptRuntime?: string;
}

export function createNodeCommandBackend(
	options: NodeCommandBackendOptions,
): CustomCommandBackend {
	if (!options.environmentId)
		throw new Error(
			"Custom commands require an explicitly namespace-bound process backend",
		);
	const env = { ...(options.env ?? process.env) };
	return {
		environmentId: options.environmentId,
		platform: process.platform,
		javascriptRuntime: options.javascriptRuntime ?? process.execPath,
		run: (request, signal) => runNodeCommand(request, env, signal),
	};
}

const MAX_OUTPUT_BYTES = 50 * 1024;

async function runNodeCommand(
	request: CustomCommandRequest,
	env: NodeJS.ProcessEnv,
	signal?: AbortSignal,
): Promise<string> {
	signal?.throwIfAborted();
	return new Promise((resolve, reject) => {
		const child = spawn(request.command, [...request.args], {
			cwd: request.cwd,
			env,
			shell: false,
			detached: process.platform !== "win32",
			stdio: [request.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let bytes = 0;
		let cause: Error | undefined;
		let ended = false;
		let drainTimer: ReturnType<typeof setTimeout> | undefined;
		let exitedCode: number | null | undefined;
		const stdoutDecoder = new StringDecoder("utf8");
		const stderrDecoder = new StringDecoder("utf8");
		const kill = () => {
			try {
				if (process.platform !== "win32" && child.pid)
					process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH")
					cause ??= error instanceof Error ? error : new Error(String(error));
			}
		};
		const finish = (code: number | null) => {
			if (ended) return;
			ended = true;
			clearTimeout(drainTimer);
			signal?.removeEventListener("abort", onAbort);
			if (cause) kill();
			child.stdin?.destroy();
			child.stdout?.destroy();
			child.stderr?.destroy();
			stdout += stdoutDecoder.end();
			stderr += stderrDecoder.end();
			if (cause) reject(cause);
			else if (code !== 0)
				reject(
					new Error(
						`Command exited with code ${code ?? "unknown"}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
					),
				);
			else resolve(stdout.trimEnd() || stderr.trimEnd() || "(no output)");
		};
		const stop = (error: Error) => {
			cause ??= error;
			kill();
			if (exitedCode !== undefined)
				drainTimer ??= setTimeout(() => finish(exitedCode ?? null), 100);
		};
		const onAbort = () => stop(new Error("Command aborted"));
		const append = (target: "stdout" | "stderr", chunk: Buffer) => {
			if (ended || cause) return;
			bytes += chunk.length;
			if (bytes > MAX_OUTPUT_BYTES) {
				stop(new Error(`Command output exceeded ${MAX_OUTPUT_BYTES} bytes`));
				return;
			}
			if (target === "stdout") stdout += stdoutDecoder.write(chunk);
			else stderr += stderrDecoder.write(chunk);
		};
		child.stdout?.on("data", (chunk) => append("stdout", chunk));
		child.stderr?.on("data", (chunk) => append("stderr", chunk));
		child.stdout?.on("error", (error) => stop(error));
		child.stderr?.on("error", (error) => stop(error));
		child.on("error", (error) => {
			cause ??= error;
		});
		child.once("exit", (code) => {
			exitedCode = code;
			if (cause) drainTimer ??= setTimeout(() => finish(code), 100);
		});
		child.once("close", (code) => finish(code));
		child.stdin?.on("error", (error) => stop(error));
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
		if (request.stdin !== undefined) child.stdin?.end(request.stdin);
	});
}
