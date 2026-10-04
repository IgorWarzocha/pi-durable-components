import { spawn } from "node:child_process";
import { constants } from "node:os";
import type {
	ShellProcess,
	ShellProcessBackend,
	ShellProcessEvents,
	ShellSpawnRequest,
} from "./backend.ts";
import { getCodexRuntimeShell } from "./shell-args.ts";

export interface NodeShellBackendOptions {
	/** Bind only to a namespace the host has verified is local. */
	environmentId: string;
	env?: NodeJS.ProcessEnv;
	defaultShell?: string;
}

/** Local child_process and node-pty capability. Construction does not start a process. */
export function createNodeShellBackend(
	options: NodeShellBackendOptions,
): ShellProcessBackend {
	if (!options.environmentId)
		throw new Error(
			"Node shell backend requires an explicit local environmentId",
		);
	const env = { ...(options.env ?? process.env) };
	const defaultShell = getCodexRuntimeShell(
		options.defaultShell ?? env["SHELL"],
		process.platform,
		process.platform === "win32" ? (env["COMSPEC"] ?? "cmd.exe") : "/bin/bash",
	);
	return {
		environmentId: options.environmentId,
		platform: process.platform,
		env,
		defaultShell,
		spawn: (request, events) =>
			request.tty ? spawnPty(request, events) : spawnPipe(request, events),
	};
}

function exitCode(code: number | null, signal: NodeJS.Signals | null): number {
	return code ?? (signal ? 128 + constants.signals[signal] : 1);
}

function spawnPipe(
	request: ShellSpawnRequest,
	events: ShellProcessEvents,
): Promise<ShellProcess> {
	return new Promise((resolve, reject) => {
		const child = spawn(request.shell, [...request.args], {
			cwd: request.cwd,
			env: request.env,
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});
		let closed = false;
		let terminating: Promise<void> | undefined;
		let drainTimer: ReturnType<typeof setTimeout> | undefined;
		let resolveClosed!: () => void;
		const completion = new Promise<void>((done) => {
			resolveClosed = done;
		});
		const finish = (code: number) => {
			if (closed) return;
			// A terminated shell can exit before descendants. Reap its owned process group too.
			if (terminating && process.platform !== "win32") kill("SIGKILL");
			closed = true;
			if (drainTimer) clearTimeout(drainTimer);
			child.stdout.destroy();
			child.stderr.destroy();
			events.closed(code);
			resolveClosed();
		};
		const kill = (signal: NodeJS.Signals) => {
			try {
				if (process.platform !== "win32" && child.pid)
					process.kill(-child.pid, signal);
				else child.kill(signal);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			}
		};
		child.stdout.on("data", (chunk: Buffer) => events.output("stdout", chunk));
		child.stderr.on("data", (chunk: Buffer) => events.output("stderr", chunk));
		child.once("error", (error) => {
			finish(1);
			reject(error);
		});
		child.once("exit", (code, signal) => {
			if (closed) return;
			// Grandchildren may retain pipe descriptors after the shell exits. Match the source drain grace.
			drainTimer = setTimeout(() => finish(exitCode(code, signal)), 100);
		});
		child.once("close", (code, signal) => finish(exitCode(code, signal)));
		child.once("spawn", () =>
			resolve({
				write: async () => {
					throw new Error(
						"stdin is closed for this session; rerun exec_command with tty=true to keep stdin open",
					);
				},
				terminate: () =>
					(terminating ??= (async () => {
						if (closed) return;
						kill("SIGKILL");
						await completion;
					})()),
			}),
		);
	});
}

async function spawnPty(
	request: ShellSpawnRequest,
	events: ShellProcessEvents,
): Promise<ShellProcess> {
	// node-pty's libuv PTY integration reports corrupt exit signals and drops output
	// under Bun 1.4.2. Reject this unsupported runtime instead of claiming a terminal.
	if (process.versions["bun"])
		throw new Error(
			"The local PTY backend requires a Node.js host; run the host with Node.js or select a compatible process backend",
		);
	// Remote capabilities and non-TTY commands do not require a working native PTY addon.
	let pty: typeof import("node-pty");
	try {
		pty = await import("node-pty");
	} catch (cause) {
		throw new Error(
			"Local PTY capability unavailable; install or rebuild node-pty@1.1.0 for this Node.js host",
			{ cause },
		);
	}
	const env = Object.fromEntries(
		Object.entries(request.env).filter(
			(entry): entry is [string, string] => typeof entry[1] === "string",
		),
	);
	// Byte mode keeps decoding under the same per-stream owner as pipe output.
	const terminal = pty.spawn(request.shell, [...request.args], {
		cwd: request.cwd,
		env,
		name: "xterm-256color",
		cols: 80,
		rows: 24,
		encoding: null,
	});
	let closed = false;
	let terminating: Promise<void> | undefined;
	let resolveClosed!: () => void;
	const completion = new Promise<void>((done) => {
		resolveClosed = done;
	});
	const kill = (signal: NodeJS.Signals) => {
		try {
			if (process.platform !== "win32") process.kill(-terminal.pid, signal);
			else terminal.kill(signal);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	};
	const data = terminal.onData((chunk) => events.output("pty", chunk));
	const exited = terminal.onExit((result) => {
		if (terminating && process.platform !== "win32") kill("SIGKILL");
		closed = true;
		data.dispose();
		exited.dispose();
		events.closed(result.signal ? 128 + result.signal : result.exitCode);
		resolveClosed();
	});
	return {
		write: async (chars) => {
			if (closed) throw new Error("Process already exited; cannot write stdin");
			terminal.write(chars);
		},
		terminate: () =>
			(terminating ??= (async () => {
				if (closed) return;
				kill("SIGKILL");
				await completion;
			})()),
	};
}
