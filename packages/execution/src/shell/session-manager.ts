// Copyright (c) 2026 Igor Warzocha. MIT licensed.
// Host algorithms adapted from pi-codex-conversion at b2006db9def12c373ae48e70044d30f7d6b7e34f.

import { randomBytes } from "node:crypto";
import type { ShellProcessBackend } from "./backend.ts";
import {
	createProcessSessionRuntime,
	type ProcessExecSession,
	type ProcessSessionHooks,
} from "./process-session.ts";
import { makeSnapshotResult, makeSnapshotSince } from "./results.ts";
import {
	type ExecSessionChangeReason,
	type ExecSessionSnapshot,
	ExecSessionStore,
	type UnifiedExecResult,
} from "./session-store.ts";
import {
	clampExecYieldTime,
	clampWriteYieldTime,
	DEFAULT_EXEC_YIELD_TIME_MS,
	DEFAULT_MAX_EMPTY_WRITE_YIELD_TIME_MS,
	DEFAULT_WRITE_YIELD_TIME_MS,
	normalizeMinEmptyWriteYieldTime,
	normalizeMinNonInteractiveExecYieldTime,
	resolveExecution,
	resolveShell,
} from "./shell.ts";
import { registerAbortHandler, waitForExitOrInactivity } from "./wait.ts";

interface ExecCommandInput {
	cmd: string;
	workdir?: string | undefined;
	shell?: string | undefined;
	defaultShell?: string | undefined;
	env?: NodeJS.ProcessEnv | undefined;
	tty?: boolean | undefined;
	yield_time_ms?: number | undefined;
	max_yield_time_ms?: number | undefined;
	max_output_tokens?: number | undefined;
	login?: boolean | undefined;
	wait_until_exit?: boolean | undefined;
}

interface WriteStdinInput {
	session_id: number;
	chars?: string | undefined;
	yield_time_ms?: number | undefined;
	max_output_tokens?: number | undefined;
}

type ExecSessionUpdateCallback = (result: UnifiedExecResult) => void;

export interface ExecSessionManager {
	setBaseEnv(env: NodeJS.ProcessEnv): void;
	exec(
		input: ExecCommandInput,
		cwd: string,
		signal?: AbortSignal,
		onUpdate?: ExecSessionUpdateCallback,
	): Promise<UnifiedExecResult>;
	write(
		input: WriteStdinInput,
		signal?: AbortSignal,
		onUpdate?: ExecSessionUpdateCallback,
	): Promise<UnifiedExecResult>;
	hasSession(sessionId: number): boolean;
	getSessionCommand(sessionId: number): string | undefined;
	listSessions(maxOutputChars?: number): ExecSessionSnapshot[];
	terminateSession(sessionId: number): boolean;
	onSessionChange(
		listener: (reason: ExecSessionChangeReason) => void,
	): () => void;
	onSessionExit(
		listener: (sessionId: number, command: string) => void,
	): () => void;
	shutdown(): Promise<void>;
}

export interface ExecSessionManagerOptions {
	env?: NodeJS.ProcessEnv | undefined;
	backend: ShellProcessBackend;
	defaultExecYieldTimeMs?: number | undefined;
	defaultWriteYieldTimeMs?: number | undefined;
	minNonInteractiveExecYieldTimeMs?: number | undefined;
	minEmptyWriteYieldTimeMs?: number | undefined;
	maxEmptyWriteYieldTimeMs?: number | undefined;
	maxSessionBufferChars?: number | undefined;
}

export function createExecSessionManager(
	options: ExecSessionManagerOptions,
): ExecSessionManager {
	// Random epoch prevents old persisted IDs from addressing new processes after restart.
	let nextSessionId = randomBytes(6).readUIntBE(0, 6);
	const processSessions = createProcessSessionRuntime(options.backend);
	let shuttingDown = false;
	let shutdownPromise: Promise<void> | undefined;
	let baseEnv: NodeJS.ProcessEnv = { ...(options.env ?? options.backend.env) };
	const defaultExecYieldTimeMs =
		options.defaultExecYieldTimeMs ?? DEFAULT_EXEC_YIELD_TIME_MS;
	const defaultWriteYieldTimeMs =
		options.defaultWriteYieldTimeMs ?? DEFAULT_WRITE_YIELD_TIME_MS;
	const minNonInteractiveExecYieldTimeMs =
		normalizeMinNonInteractiveExecYieldTime(
			options.minNonInteractiveExecYieldTimeMs,
		);
	const minEmptyWriteYieldTimeMs = normalizeMinEmptyWriteYieldTime(
		options.minEmptyWriteYieldTimeMs,
	);
	const maxEmptyWriteYieldTimeMs = Math.max(
		minEmptyWriteYieldTimeMs,
		options.maxEmptyWriteYieldTimeMs ?? DEFAULT_MAX_EMPTY_WRITE_YIELD_TIME_MS,
	);
	const configuredMaxSessionBufferChars =
		options.maxSessionBufferChars === undefined
			? undefined
			: Math.max(1024, options.maxSessionBufferChars);

	function setBaseEnv(env: NodeJS.ProcessEnv): void {
		baseEnv = { ...env };
	}

	const store = new ExecSessionStore(configuredMaxSessionBufferChars);
	const processHooks: ProcessSessionHooks = {
		isOwned: (session: ProcessExecSession) =>
			!shuttingDown && store.get(session.id) === session,
		onOutput: (session: ProcessExecSession, text: string) =>
			store.appendOutput(session, text),
		onExit: (session: ProcessExecSession) => store.finalizeSession(session),
	};

	return {
		setBaseEnv,
		exec: async (input, cwd, signal, onUpdate) => {
			if (shuttingDown) throw new Error("exec manager is shut down");
			signal?.throwIfAborted();
			const requestedShell = input.shell ?? input.defaultShell;
			const shell = resolveShell(
				requestedShell,
				options.backend.platform,
				options.backend.defaultShell,
			);
			const workdir = input.workdir ?? cwd;
			const execution = resolveExecution(
				requestedShell,
				input.cmd,
				input.env,
				baseEnv,
				options.backend.platform,
				options.backend.defaultShell,
			);
			const session = processSessions.create({
				id: nextSessionId++,
				input: {
					command: input.cmd,
					executionCommand: execution.command,
					executionEnv: execution.env,
					...(input.tty === undefined ? {} : { tty: input.tty }),
					...(input.login === undefined ? {} : { login: input.login }),
				},
				workdir,
				shell,
				...(signal ? { signal } : {}),
				hooks: processHooks,
			});
			store.add(session);
			const abortCleanup = registerAbortHandler(signal, () => {
				if (session.exitCode === undefined) session.terminating = true;
			});

			try {
				onUpdate?.(
					makeSnapshotResult(session, 0, input.max_output_tokens, true),
				);
				const execYieldMs = clampExecYieldTime(
					input.yield_time_ms,
					defaultExecYieldTimeMs,
					session.interactive,
					minNonInteractiveExecYieldTimeMs,
					input.max_yield_time_ms,
				);
				const maxExecWaitMs = Math.max(
					execYieldMs,
					input.max_yield_time_ms ?? execYieldMs,
				);
				let waitedMs = 0;
				let idleTimeMs = execYieldMs;
				for (;;) {
					const elapsedMs = await waitForExitOrInactivity(
						session,
						idleTimeMs,
						maxExecWaitMs,
						signal,
						onUpdate
							? (elapsed) =>
									onUpdate(
										makeSnapshotResult(
											session,
											waitedMs + elapsed,
											input.max_output_tokens,
										),
									)
							: undefined,
					);
					waitedMs += elapsedMs;
					if (signal?.aborted) {
						throw signal.reason instanceof Error
							? signal.reason
							: new Error("exec aborted");
					}
					if (
						!input.wait_until_exit ||
						(session.exitCode !== undefined && session.exitCode !== null)
					)
						break;
					idleTimeMs = Math.min(maxExecWaitMs, idleTimeMs * 2);
				}
				await processSessions.waitForStartup(session, signal);
				if (session.exitCode === undefined || session.exitCode === null)
					session.nextEmptyPollYieldMs = growEmptyPollYield(
						Math.max(execYieldMs, waitedMs),
						maxEmptyWriteYieldTimeMs,
					);
				return store.finishResult(session, waitedMs, input.max_output_tokens);
			} catch (error) {
				if (signal?.aborted) {
					await processSessions.terminate(session);
					store.remove(session.id);
				}
				throw error;
			} finally {
				abortCleanup();
			}
		},
		write: async (input, signal, onUpdate) => {
			if (shuttingDown) throw new Error("exec manager is shut down");
			if (signal?.aborted) {
				throw new Error("write_stdin aborted");
			}
			const session = store.get(input.session_id);
			if (!session) {
				const completed = store.completedPoll(
					input.session_id,
					input.chars ?? "",
					input.max_output_tokens,
				);
				if (completed) return completed;
				throw new Error(
					`Unknown or expired process id ${input.session_id}; sessions are process-local and do not survive restart`,
				);
			}
			const updateBaseline = session.bufferStartOffset + session.buffer.length;
			const chars = input.chars ?? "";
			const isEmptyPoll = chars.length === 0;
			if (!isEmptyPoll) {
				if (!session.interactive) {
					throw new Error(
						"stdin is closed for this session; rerun exec_command with tty=true to keep stdin open",
					);
				}
				await processSessions.write(session, chars);
				session.nextEmptyPollYieldMs = undefined;
			}
			onUpdate?.(
				makeSnapshotSince(session, 0, updateBaseline, input.max_output_tokens),
			);
			const requestedYieldMs = clampWriteYieldTime(
				input.yield_time_ms,
				defaultWriteYieldTimeMs,
				isEmptyPoll,
				minEmptyWriteYieldTimeMs,
				maxEmptyWriteYieldTimeMs,
			);
			const effectiveYieldMs = isEmptyPoll
				? Math.max(requestedYieldMs, session.nextEmptyPollYieldMs ?? 0)
				: requestedYieldMs;
			const abortCleanup = registerAbortHandler(signal, () => {
				session.terminating = true;
			});
			try {
				const waitedMs =
					session.exitCode === undefined
						? await waitForExitOrInactivity(
								session,
								effectiveYieldMs,
								effectiveYieldMs,
								signal,
								onUpdate
									? (elapsedMs) =>
											onUpdate(
												makeSnapshotSince(
													session,
													elapsedMs,
													updateBaseline,
													input.max_output_tokens,
												),
											)
									: undefined,
							)
						: 0;
				await processSessions.waitForStartup(session, signal);
				if (
					isEmptyPoll &&
					(session.exitCode === undefined || session.exitCode === null)
				)
					session.nextEmptyPollYieldMs = growEmptyPollYield(
						effectiveYieldMs,
						maxEmptyWriteYieldTimeMs,
					);
				signal?.throwIfAborted();
				return store.finishResult(session, waitedMs, input.max_output_tokens);
			} catch (error) {
				if (signal?.aborted) await processSessions.terminate(session);
				throw error;
			} finally {
				abortCleanup();
			}
		},
		hasSession: (id) => store.hasSession(id),
		getSessionCommand: (id) => store.getSessionCommand(id),
		listSessions: (maxOutputChars) => store.listSessions(maxOutputChars),
		terminateSession: (id) =>
			store.terminateSession(id, processSessions.terminate),
		onSessionChange: (listener) => store.onSessionChange(listener),
		onSessionExit: (listener) => store.onSessionExit(listener),
		shutdown: () =>
			(shutdownPromise ??= (async () => {
				shuttingDown = true;
				try {
					await processSessions.shutdown();
				} finally {
					store.clear();
				}
			})()),
	};
}

function growEmptyPollYield(currentMs: number, maximumMs: number): number {
	return Math.min(maximumMs, currentMs * 2);
}
