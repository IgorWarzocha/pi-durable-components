import { StringDecoder } from "node:string_decoder";
import type { ShellProcess, ShellProcessBackend } from "./backend.ts";
import { getShellArgs } from "./shell-args.ts";

export interface ProcessExecSession {
	id: number;
	startup: Promise<void>;
	started: boolean;
	tty: boolean;
	command: string;
	buffer: string;
	bufferStartOffset: number;
	emittedOffset: number;
	outputVersion: number;
	exitCode: number | undefined;
	listeners: Set<() => void>;
	interactive: boolean;
	nextEmptyPollYieldMs?: number | undefined;
	startedAt: number;
	updatedAt: number;
	finalized: boolean;
	exposed: boolean;
	terminating: boolean;
	process?: ShellProcess;
}

export interface ProcessSessionHooks {
	isOwned(session: ProcessExecSession): boolean;
	onOutput(session: ProcessExecSession, text: string): void;
	onExit(session: ProcessExecSession): void;
}

interface CreateSession {
	id: number;
	input: {
		command: string;
		executionCommand: string;
		executionEnv: NodeJS.ProcessEnv;
		tty?: boolean;
		login?: boolean;
	};
	workdir: string;
	shell: string;
	signal?: AbortSignal;
	hooks: ProcessSessionHooks;
}

/** Owns asynchronous startup and per-stream codecs. The manager owns retention and wait policy. */
export function createProcessSessionRuntime(backend: ShellProcessBackend) {
	const active = new Set<ProcessExecSession>();
	let shuttingDown = false;

	function create({
		id,
		input,
		workdir,
		shell,
		signal,
		hooks,
	}: CreateSession): ProcessExecSession {
		const session: ProcessExecSession = {
			id,
			startup: Promise.resolve(),
			started: false,
			tty: Boolean(input.tty),
			command: input.command,
			buffer: "",
			bufferStartOffset: 0,
			emittedOffset: 0,
			outputVersion: 0,
			exitCode: undefined,
			listeners: new Set(),
			interactive: Boolean(input.tty),
			startedAt: Date.now(),
			updatedAt: Date.now(),
			finalized: false,
			exposed: false,
			terminating: false,
		};
		const decoders = {
			stdout: new StringDecoder("utf8"),
			stderr: new StringDecoder("utf8"),
			pty: new StringDecoder("utf8"),
		};
		const close = (code: number) => {
			if (session.exitCode !== undefined) return;
			for (const decoder of Object.values(decoders))
				hooks.onOutput(session, decoder.end());
			session.exitCode = session.terminating && code === 0 ? 143 : code;
			active.delete(session);
			hooks.onExit(session);
		};
		active.add(session);
		// Defer so the manager can establish ownership before a backend emits synchronously.
		session.startup = Promise.resolve().then(async () => {
			try {
				if (shuttingDown || signal?.aborted) {
					session.terminating = true;
					close(143);
					return;
				}
				session.process = await backend.spawn(
					{
						shell,
						args: getShellArgs(
							shell,
							input.executionCommand,
							input.login ?? true,
						),
						cwd: workdir,
						env: input.executionEnv,
						tty: Boolean(input.tty),
					},
					{
						output: (stream, chunk) => {
							if (session.exitCode !== undefined || !hooks.isOwned(session))
								return;
							hooks.onOutput(
								session,
								typeof chunk === "string"
									? chunk
									: decoders[stream].write(Buffer.from(chunk)),
							);
						},
						closed: close,
					},
				);
				session.started = true;
			} catch (error) {
				hooks.onOutput(
					session,
					`${error instanceof Error ? error.message : String(error)}\n`,
				);
				close(1);
			}
		});
		return session;
	}

	async function terminate(session: ProcessExecSession): Promise<void> {
		session.terminating = true;
		await session.startup;
		await session.process?.terminate();
	}

	return {
		create,
		waitForStartup: async (
			session: ProcessExecSession,
			signal?: AbortSignal,
		) => {
			await session.startup;
			signal?.throwIfAborted();
		},
		write: async (session: ProcessExecSession, chars: string) => {
			await session.startup;
			if (!session.process || session.exitCode !== undefined)
				throw new Error(
					`Process id ${session.id} already exited; cannot write stdin`,
				);
			await session.process.write(chars);
		},
		terminate,
		shutdown: async () => {
			shuttingDown = true;
			const results = await Promise.allSettled([...active].map(terminate));
			const failures = results.flatMap((result) =>
				result.status === "rejected" ? [result.reason] : [],
			);
			if (failures.length)
				throw new AggregateError(
					failures,
					"Shell process cleanup failed; process outcomes may be uncertain",
				);
		},
	};
}
