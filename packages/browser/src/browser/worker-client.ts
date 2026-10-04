import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { isRecordValue } from "./operation-input.ts";
import {
	ensureWorkerSocketDirectory,
	readLine,
	type WorkerResponse,
	workerSocketPath,
} from "./worker-socket.ts";

const START_TIMEOUT_MS = 5_000;
const IS_WINDOWS = process.platform === "win32";

async function requestOnce(
	input: string,
	workerId: string,
	signal?: AbortSignal,
): Promise<WorkerResponse> {
	if (signal?.aborted) {
		return Promise.reject(
			signal.reason ?? new Error("Browser worker request aborted"),
		);
	}
	await ensureWorkerSocketDirectory(workerId);
	if (signal?.aborted) {
		throw signal.reason ?? new Error("Browser worker request aborted");
	}
	return new Promise((resolveValue, reject) => {
		const socket = createConnection(workerSocketPath(workerId));
		const abort = () => {
			socket.destroy();
			reject(signal?.reason ?? new Error("Browser worker request aborted"));
		};
		signal?.addEventListener("abort", abort, { once: true });
		socket.once("connect", () => socket.write(`${input}\n`));
		void readLine(socket).then(
			(line) => {
				signal?.removeEventListener("abort", abort);
				socket.destroy();
				try {
					const response: unknown = JSON.parse(line);
					if (!isRecordValue(response) || typeof response["ok"] !== "boolean") {
						throw new Error("Browser worker returned an invalid response");
					}
					if (response["ok"] === true && isRecordValue(response["result"])) {
						resolveValue({ ok: true, result: response["result"] });
					} else if (
						response["ok"] === false &&
						typeof response["error"] === "string"
					) {
						resolveValue({ ok: false, error: response["error"] });
					} else {
						throw new Error("Browser worker returned an invalid response");
					}
				} catch (error) {
					reject(error);
				}
			},
			(error) => {
				signal?.removeEventListener("abort", abort);
				socket.destroy();
				reject(error);
			},
		);
	});
}

function canStartWorker(error: unknown): boolean {
	return (
		error instanceof Error &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ECONNREFUSED")
	);
}

export async function requestBrowserWorker(
	input: string,
	entryPath: string,
	workerId: string,
	signal?: AbortSignal,
): Promise<Record<string, unknown>> {
	try {
		const response = await requestOnce(input, workerId, signal);
		if (!response.ok)
			throw new Error(response.error ?? "Browser worker failed");
		if (!response.result) throw new Error("Browser worker returned no result");
		return response.result;
	} catch (error) {
		if (!canStartWorker(error)) throw error;
	}
	if (!IS_WINDOWS) await rm(workerSocketPath(workerId), { force: true });
	signal?.throwIfAborted();
	const child = spawn(
		process.execPath,
		["--preserve-symlinks-main", entryPath, "--daemon"],
		{ detached: true, stdio: "ignore" },
	);
	child.unref();
	const deadline = Date.now() + START_TIMEOUT_MS;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			const response = await requestOnce(input, workerId, signal);
			if (!response.ok)
				throw new Error(response.error ?? "Browser worker failed");
			if (!response.result)
				throw new Error("Browser worker returned no result");
			return response.result;
		} catch (error) {
			if (!canStartWorker(error)) throw error;
			lastError = error;
			await new Promise((resolveValue) => setTimeout(resolveValue, 50));
		}
	}
	throw new Error(
		`Browser worker did not start within ${START_TIMEOUT_MS}ms${lastError instanceof Error ? `: ${lastError.message}` : ""}`,
	);
}
