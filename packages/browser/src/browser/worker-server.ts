import { rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { dirname } from "node:path";
import { nodeArtifactStore } from "./artifact-store.ts";
import type { BrowserOperation } from "./operation.ts";
import { isRecordValue, parseActionRequest } from "./parse-operation.ts";
import { BrowserRoutes } from "./routes.ts";
import { BrowserRuntime } from "./runtime.ts";
import {
	ensureWorkerSocketDirectory,
	readLine,
	type WorkerResponse,
	workerSocketPath,
} from "./worker-socket.ts";

const IDLE_TIMEOUT_MS = 20 * 60 * 1_000;
const IS_WINDOWS = process.platform === "win32";

interface WorkerRequest {
	operations: BrowserOperation[];
	ownerId: string;
}

function parseWorkerRequest(input: string): WorkerRequest {
	let value: unknown;
	try {
		value = JSON.parse(input);
	} catch (error) {
		throw new Error(
			`worker input must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!isRecordValue(value)) throw new Error("worker input must be an object");
	const unknown = Object.keys(value).filter(
		(key) => key !== "owner_id" && key !== "operations",
	);
	if (unknown.length > 0) {
		throw new Error(`unknown worker field(s): ${unknown.join(", ")}`);
	}
	if (
		typeof value["owner_id"] !== "string" ||
		value["owner_id"].length === 0 ||
		value["owner_id"].length > 256
	) {
		throw new Error(
			"worker owner_id must be a non-empty string no longer than 256 characters",
		);
	}
	if (!Array.isArray(value["operations"]) || value["operations"].length === 0) {
		throw new Error("worker operations must be a non-empty array");
	}
	const operations = value["operations"].map((operation, index) => {
		if (!isRecordValue(operation)) {
			throw new Error(`worker operations[${index}] must be an object`);
		}
		const parsed = parseActionRequest(operation);
		if (parsed.action === "help") {
			throw new Error("help is not a worker operation");
		}
		return parsed;
	});
	return { operations, ownerId: value["owner_id"] };
}

async function handleConnection(
	socket: Socket,
	runtime: BrowserRuntime,
): Promise<void> {
	const controller = new AbortController();
	const abort = () =>
		controller.abort(new Error("Browser worker requester disconnected"));
	socket.once("close", abort);
	socket.once("error", abort);
	let response: WorkerResponse;
	try {
		const request = parseWorkerRequest(await readLine(socket));
		response = {
			ok: true,
			result: await runtime.execute(
				{ operations: request.operations },
				{ ownerId: request.ownerId, signal: controller.signal },
			),
		};
	} catch (error) {
		response = {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
	socket.off("close", abort);
	socket.off("error", abort);
	if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
}

export async function serveBrowserWorker(workerId: string): Promise<void> {
	const path = workerSocketPath(workerId);
	await ensureWorkerSocketDirectory(workerId);
	const directory = dirname(path);
	const runtime = new BrowserRuntime({
		routes: new BrowserRoutes(),
		stateDirectory: directory,
		artifacts: nodeArtifactStore(directory),
	});
	let ownsSocket = false;
	let closed = false;
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		resetIdle();
		void handleConnection(socket, runtime).finally(resetIdle);
	});
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	const close = () => {
		if (closed) return;
		closed = true;
		void runtime.close();
		for (const socket of sockets) socket.destroy();
		server.close();
	};
	const resetIdle = () => {
		if (closed) return;
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = setTimeout(close, IDLE_TIMEOUT_MS);
		idleTimer.unref?.();
	};
	process.once("SIGINT", close);
	process.once("SIGTERM", close);
	try {
		await new Promise<void>((resolveValue, reject) => {
			server.once("error", reject);
			server.listen(path, () => {
				ownsSocket = true;
				server.off("error", reject);
				resetIdle();
			});
			server.once("close", resolveValue);
		});
	} finally {
		if (idleTimer) clearTimeout(idleTimer);
		process.removeListener("SIGINT", close);
		process.removeListener("SIGTERM", close);
		await runtime.close();
		if (!IS_WINDOWS && ownsSocket) await rm(path, { force: true });
	}
}
