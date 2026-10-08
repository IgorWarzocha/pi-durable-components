import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

/** Every failure waits for close, so an owned index can safely be removed. */
export function runGit(
	cwd: string,
	args: string[],
	options: {
		signal?: AbortSignal | undefined;
		index?: string;
		timeout?: number;
		maxBytes?: number;
		onChunk?: ((chunk: string) => void) | undefined;
	} = {},
): Promise<Buffer> {
	options.signal?.throwIfAborted();
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key.startsWith("GIT_")) delete env[key];
	}
	Object.assign(env, { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" });
	if (options.index) env["GIT_INDEX_FILE"] = options.index;
	return new Promise((resolve, reject) => {
		const ownsProcessGroup = process.platform !== "win32";
		const child = spawn("git", args, {
			cwd,
			env,
			detached: ownsProcessGroup,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const kill = (signal: NodeJS.Signals) => {
			if (ownsProcessGroup && child.pid) {
				try {
					process.kill(-child.pid, signal);
				} catch (error) {
					if (
						!(
							error instanceof Error &&
							"code" in error &&
							error.code === "ESRCH"
						)
					)
						child.kill(signal);
				}
			} else child.kill(signal);
		};
		const chunks: Buffer[] = [];
		const decoder = new StringDecoder("utf8");
		let bytes = 0;
		let stderr = "";
		let failure: unknown;
		let failed = false;
		let escalation: ReturnType<typeof setTimeout> | undefined;
		const stop = (error: unknown) => {
			if (failed) return;
			failed = true;
			failure = error;
			kill("SIGTERM");
			escalation = setTimeout(() => kill("SIGKILL"), 250);
		};
		const abort = () =>
			stop(options.signal?.reason ?? new Error("Git command cancelled."));
		const timeoutMs = options.timeout ?? 20_000;
		const timer = setTimeout(
			() => stop(new Error(`Git command timed out after ${timeoutMs}ms.`)),
			timeoutMs,
		);
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) abort();
		child.stdout.on("data", (chunk: Buffer) => {
			if (failed) return;
			bytes += chunk.length;
			if (bytes > (options.maxBytes ?? 64 * 1024 * 1024)) {
				stop(new Error("Git command produced too much stdout."));
				return;
			}
			chunks.push(chunk);
			try {
				const text = decoder.write(chunk);
				if (text) options.onChunk?.(text);
			} catch (error) {
				stop(error);
			}
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString("utf8")).slice(-1024 * 1024);
		});
		child.on("error", stop);
		child.on("close", (code, signal) => {
			if (failed) kill("SIGKILL");
			clearTimeout(timer);
			clearTimeout(escalation);
			options.signal?.removeEventListener("abort", abort);
			if (!failed) {
				try {
					const tail = decoder.end();
					if (tail) options.onChunk?.(tail);
				} catch (error) {
					failure = error;
					failed = true;
				}
			}
			if (failed) reject(failure);
			else if (code !== 0)
				reject(
					Object.assign(
						new Error(
							`Git command failed with ${signal ?? `exit code ${code}`}: ${stderr.trim()}`,
						),
						{ code, stderr },
					),
				);
			else resolve(Buffer.concat(chunks, bytes));
		});
	});
}

/** Resolve first, then use only the immutable tree OID in later argument lists. */
export async function resolveTree(
	cwd: string,
	revision: string,
	signal?: AbortSignal,
): Promise<string> {
	const value = revision.trim();
	if (!value || value.startsWith("-") || value.includes("\0"))
		throw new Error("Invalid Git revision.");
	return (
		await runGit(
			cwd,
			["rev-parse", "--verify", "--end-of-options", `${value}^{tree}`],
			{ signal, maxBytes: 65536 },
		)
	)
		.toString("utf8")
		.trim();
}

export function isGitExit(error: unknown): boolean {
	return (
		error instanceof Error && "code" in error && typeof error.code === "number"
	);
}
