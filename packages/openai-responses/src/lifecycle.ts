import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createCodexTurnState } from "./openai-codex/turn-state.ts";

/** Owns cancellation and turn affinity independently of the physical socket cache. */
export function createRequestLifecycle() {
	const active = new Set<{
		sessionId: string | undefined;
		controller: AbortController;
		done: Promise<void>;
	}>();
	const turns = new Map<string, ReturnType<typeof createCodexTurnState>>();
	const resetting = new Map<string, Promise<void>>();
	let closed = false;
	let closing: Promise<void> | undefined;

	return {
		begin(sessionId: string | undefined, signal: AbortSignal | undefined) {
			if (closed) throw new Error("OpenAI Responses provider is closed");
			if (sessionId && resetting.has(sessionId))
				throw new Error("OpenAI Responses session is being reset");
			const controller = new AbortController();
			let settle!: () => void;
			const done = new Promise<void>((resolve) => {
				settle = resolve;
			});
			const concurrent = [...active].some((op) => op.sessionId === sessionId);
			const turnState =
				(sessionId && !concurrent ? turns.get(sessionId) : undefined) ??
				createCodexTurnState();
			if (sessionId && !concurrent) turns.set(sessionId, turnState);
			const operation = { sessionId, controller, done };
			active.add(operation);
			const abort = () => controller.abort(signal?.reason);
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
			return {
				signal: controller.signal,
				turnState,
				finish(output?: AssistantMessage) {
					if (!active.delete(operation)) return;
					signal?.removeEventListener("abort", abort);
					// A tool result continues the same backend turn. Final/error responses end it.
					if (output && output.stopReason !== "toolUse") turnState.reset();
					settle();
				},
			};
		},
		reset(sessionId: string, clear: () => void | Promise<void>): Promise<void> {
			const existing = resetting.get(sessionId);
			if (existing) return existing;
			const operations = [...active].filter((op) => op.sessionId === sessionId);
			for (const operation of operations) operation.controller.abort();
			const clearing = clear();
			const pending = Promise.all([
				...operations.map((op) => op.done),
				clearing,
			])
				.then(async () => {
					await clear();
					turns.delete(sessionId);
				})
				.finally(() => {
					resetting.delete(sessionId);
				});
			resetting.set(sessionId, pending);
			return pending;
		},
		close(clear: () => void | Promise<void>): Promise<void> {
			if (closing) return closing;
			closed = true;
			for (const operation of active) operation.controller.abort();
			const clearing = clear();
			closing = Promise.all(
				[...active].map((op) => op.done).concat(Promise.resolve(clearing)),
			).then(async () => {
				await clear();
				turns.clear();
			});
			return closing;
		},
	};
}
