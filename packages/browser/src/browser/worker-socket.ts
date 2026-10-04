import { chmod, lstat, mkdir } from "node:fs/promises";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";

const INPUT_LIMIT_BYTES = 8 * 1_024 * 1_024;
const IS_WINDOWS = process.platform === "win32";

export type WorkerResponse =
	| { ok: true; result: Record<string, unknown> }
	| { ok: false; error: string };

export function workerSocketPath(workerId: string): string {
	if (IS_WINDOWS) return `\\\\.\\pipe\\pi-durable-browser-worker-${workerId}`;
	const directory = process.env["XDG_RUNTIME_DIR"]
		? join(process.env["XDG_RUNTIME_DIR"], "pi-durable-browser")
		: join(tmpdir(), `pi-durable-browser-${process.getuid?.() ?? "user"}`);
	return join(directory, `worker-${workerId}.sock`);
}

export async function ensureWorkerSocketDirectory(
	workerId: string,
): Promise<void> {
	if (IS_WINDOWS) return;
	const directory = dirname(workerSocketPath(workerId));
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const info = await lstat(directory);
	const uid = process.getuid?.();
	if (info.isSymbolicLink() || !info.isDirectory()) {
		throw new Error(
			`Browser worker socket directory is not a directory: ${directory}`,
		);
	}
	if (uid === undefined || info.uid !== uid) {
		throw new Error(
			`Browser worker socket directory is not owned by this user: ${directory}`,
		);
	}
	if ((info.mode & 0o077) !== 0) await chmod(directory, 0o700);
}

export function readLine(socket: Socket): Promise<string> {
	return new Promise((resolveValue, reject) => {
		let input = "";
		let bytes = 0;
		const decoder = new StringDecoder("utf8");
		const cleanup = () => {
			socket.off("data", onData);
			socket.off("end", onEnd);
			socket.off("error", onError);
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		const onEnd = () => onError(new Error("Browser worker closed early"));
		const onData = (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > INPUT_LIMIT_BYTES) {
				cleanup();
				reject(new Error("Browser worker input exceeded 8 MiB"));
				return;
			}
			input += decoder.write(chunk);
			const newline = input.indexOf("\n");
			if (newline < 0) return;
			cleanup();
			resolveValue(input.slice(0, newline));
		};
		socket.on("data", onData);
		socket.once("end", onEnd);
		socket.once("error", onError);
	});
}
