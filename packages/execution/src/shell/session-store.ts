// Copyright (c) 2026 Igor Warzocha. MIT licensed.
// Host algorithms adapted from pi-codex-conversion at b2006db9def12c373ae48e70044d30f7d6b7e34f.

import {
	normalizePipeOutput,
	truncateOutput,
	truncateToTail,
} from "./output.ts";
import type { ProcessExecSession } from "./process-session.ts";
import {
	makeExecResult,
	makeSnapshotResult,
	snapshotSession,
} from "./results.ts";
export type UnifiedExecResult = {
	chunk_id: string;
	wall_time_seconds: number;
	output: string;
	exit_code?: number;
	session_id?: number;
	original_token_count?: number;
	truncated?: true;
};

export interface ExecSessionSnapshot {
	id: number;
	command: string;
	running: boolean;
	exitCode?: number | undefined;
	startedAt: number;
	updatedAt: number;
	outputTail: string;
	terminating: boolean;
}

export type ExecSessionChangeReason = "start" | "output" | "exit" | "terminate";

type ExecSession = ProcessExecSession;
const MAX_COMMAND_HISTORY = 256;
const MAX_COMPLETED_SESSION_HISTORY = 32;
const MAX_COMPLETED_SESSION_OUTPUT_CHARS = 64 * 1024;
const MAX_COMPLETED_SESSION_OUTPUT_TOKENS =
	MAX_COMPLETED_SESSION_OUTPUT_CHARS / 4;
const DEFAULT_MAX_TTY_SESSION_BUFFER_CHARS = 1024 * 1024;
const DEFAULT_MAX_PIPE_SESSION_BUFFER_CHARS = 256 * 1024 * 1024;

/** Own live visibility, bounded output, termination visibility and process-local completed history. */
export class ExecSessionStore {
	private readonly sessions = new Map<number, ExecSession>();
	private readonly commandHistory = new Map<number, string>();
	private readonly completedResults = new Map<number, UnifiedExecResult>();
	private readonly changeListeners = new Set<
		(reason: ExecSessionChangeReason) => void
	>();
	private readonly exitListeners = new Set<
		(sessionId: number, command: string) => void
	>();
	private readonly configuredMaxSessionBufferChars: number | undefined;
	constructor(configuredMaxSessionBufferChars?: number) {
		this.configuredMaxSessionBufferChars = configuredMaxSessionBufferChars;
	}
	add(session: ExecSession): void {
		this.sessions.set(session.id, session);
		this.rememberCommand(session.id, session.command);
	}
	get(id: number): ExecSession | undefined {
		return this.sessions.get(id);
	}
	remove(id: number): void {
		this.sessions.delete(id);
	}
	clear(): void {
		this.sessions.clear();
		this.commandHistory.clear();
		this.completedResults.clear();
	}
	completedPoll(
		sessionId: number,
		chars: string,
		maxOutputTokens?: number,
	): UnifiedExecResult | undefined {
		const completed = this.completedResults.get(sessionId);
		if (!completed) return undefined;
		if (chars.length > 0)
			throw new Error(
				`Process id ${sessionId} already exited with code ${completed.exit_code}; cannot write stdin`,
			);
		return this.replayCompletedResult(completed, maxOutputTokens);
	}
	private rememberCommand(sessionId: number, command: string): void {
		this.commandHistory.set(sessionId, command);
		if (this.commandHistory.size <= MAX_COMMAND_HISTORY) {
			return;
		}
		const oldest = this.commandHistory.keys().next().value;
		if (oldest !== undefined) {
			this.commandHistory.delete(oldest);
		}
	}

	private rememberCompletedResult(
		sessionId: number,
		result: UnifiedExecResult,
	): void {
		const bounded = truncateToTail(
			result.output,
			MAX_COMPLETED_SESSION_OUTPUT_CHARS,
		);
		this.completedResults.set(sessionId, {
			...result,
			output:
				bounded.removed > 0
					? `[Earlier completed output omitted]\n${bounded.output}`
					: bounded.output,
			...(bounded.removed > 0 ? { truncated: true } : {}),
		});
		if (this.completedResults.size <= MAX_COMPLETED_SESSION_HISTORY) return;
		const oldest = this.completedResults.keys().next().value;
		if (oldest !== undefined) this.completedResults.delete(oldest);
	}

	private replayCompletedResult(
		result: UnifiedExecResult,
		maxOutputTokens?: number,
	): UnifiedExecResult {
		const originalCharCount =
			!result.truncated || result.original_token_count === undefined
				? result.output.length
				: result.original_token_count * 4;
		return {
			...result,
			...truncateOutput(result.output, maxOutputTokens, originalCharCount),
		};
	}

	finishResult(
		session: ExecSession,
		waitMs: number,
		maxOutputTokens?: number,
	): UnifiedExecResult {
		const completed =
			session.exitCode !== undefined && session.exitCode !== null;
		const replaySnapshot = completed
			? makeSnapshotResult(
					session,
					waitMs,
					MAX_COMPLETED_SESSION_OUTPUT_TOKENS,
					true,
				)
			: undefined;
		const result = makeExecResult(
			session,
			waitMs,
			maxOutputTokens,
			(session) => this.exposeSession(session),
			(sessionId) => this.sessions.delete(sessionId),
		);
		if (!replaySnapshot || this.sessions.has(session.id)) return result;
		this.rememberCompletedResult(session.id, {
			...replaySnapshot,
			chunk_id: result.chunk_id,
			wall_time_seconds: result.wall_time_seconds,
		});
		return result;
	}

	notify(
		session: ExecSession,
		reason: ExecSessionChangeReason = "output",
	): void {
		session.updatedAt = Date.now();
		for (const listener of session.listeners) {
			listener();
		}
		if (session.exposed) this.notifyChanged(reason);
	}

	private notifyChanged(reason: ExecSessionChangeReason): void {
		for (const listener of this.changeListeners) {
			listener(reason);
		}
	}

	finalizeSession(
		session: ExecSession,
		reason: ExecSessionChangeReason = "exit",
	): void {
		if (session.finalized) return;
		session.finalized = true;
		for (const listener of this.exitListeners) {
			listener(session.id, session.command);
		}
		this.notify(session, reason);
	}

	private exposeSession(session: ExecSession): void {
		if (
			session.exposed ||
			(session.exitCode !== undefined && session.exitCode !== null)
		)
			return;
		session.exposed = true;
		this.notifyChanged("start");
	}

	appendOutput(session: ExecSession, text: string): void {
		if (text.length === 0) return;
		const output = session.tty ? text : normalizePipeOutput(text);
		session.buffer += output;
		session.outputVersion += 1;
		const maxSessionBufferChars =
			this.configuredMaxSessionBufferChars ??
			(session.tty
				? DEFAULT_MAX_TTY_SESSION_BUFFER_CHARS
				: DEFAULT_MAX_PIPE_SESSION_BUFFER_CHARS);
		if (session.buffer.length > maxSessionBufferChars) {
			const bounded = truncateToTail(session.buffer, maxSessionBufferChars);
			session.buffer = bounded.output;
			session.bufferStartOffset += bounded.removed;
		}
		this.notify(session);
	}

	hasSession(sessionId: number): boolean {
		return this.sessions.has(sessionId);
	}
	getSessionCommand(sessionId: number): string | undefined {
		return (
			this.sessions.get(sessionId)?.command ??
			this.commandHistory.get(sessionId)
		);
	}
	listSessions(maxOutputChars?: number): ExecSessionSnapshot[] {
		const snapshotsById = new Map<number, ExecSessionSnapshot>();
		for (const session of this.sessions.values()) {
			if (!session.exposed) continue;
			if (session.exitCode !== undefined && session.exitCode !== null) continue;
			snapshotsById.set(session.id, snapshotSession(session, maxOutputChars));
		}
		return Array.from(snapshotsById.values()).sort((a, b) => a.id - b.id);
	}
	terminateSession(
		sessionId: number,
		terminate: (session: ProcessExecSession) => Promise<void>,
	): boolean {
		const session = this.sessions.get(sessionId);
		if (!session || session.exitCode !== undefined || session.terminating)
			return false;
		session.terminating = true;
		void terminate(session).catch((error) => {
			session.terminating = false;
			this.appendOutput(
				session,
				`Process termination failed: ${error instanceof Error ? error.message : String(error)}; outcome uncertain\n`,
			);
		});
		this.notify(session, "terminate");
		return true;
	}
	onSessionChange(
		listener: (reason: ExecSessionChangeReason) => void,
	): () => void {
		this.changeListeners.add(listener);
		return () => this.changeListeners.delete(listener);
	}
	onSessionExit(
		listener: (sessionId: number, command: string) => void,
	): () => void {
		this.exitListeners.add(listener);
		return () => this.exitListeners.delete(listener);
	}
}
