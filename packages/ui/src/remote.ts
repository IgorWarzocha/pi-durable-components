import {
	parseUiSnapshot,
	type UiBinding,
	type UiSnapshot,
} from "./component.ts";
import type { JsonValue } from "./lifecycle.ts";

/** The snapshot stream must subscribe before yielding its initial snapshot. */
export interface UiTransport {
	snapshots(options: { signal: AbortSignal }): AsyncIterable<UiSnapshot>;
	call: UiBinding["call"];
	stream?: UiBinding["stream"];
}

export interface UiConnection extends UiBinding {
	/** Observe disconnects and automatic cleanup failures. */
	closed: Promise<void>;
	/** Abort transport work and join the snapshot reader. Never replays actions. */
	close(): Promise<void>;
}

/** Hydrate a binding from a host transport without losing updates during mounting. */
export async function connectUiBinding(
	transport: UiTransport,
	options: { signal: AbortSignal },
): Promise<UiConnection> {
	const controller = new AbortController();
	const abort = () => controller.abort(options.signal.reason);
	options.signal.addEventListener("abort", abort, { once: true });
	if (options.signal.aborted) abort();
	const signal = controller.signal;
	const listeners = new Set<{
		next(snapshot: UiSnapshot): void;
		error(error: unknown): void;
	}>();
	let snapshot: UiSnapshot;
	let failure: { error: unknown } | undefined;
	let reader: AsyncIterator<UiSnapshot> | undefined;
	let pumping: Promise<void> = Promise.resolve();
	let started = false;
	let closing: Promise<void> | undefined;
	const close = (): Promise<void> => {
		if (closing) return closing;
		closing = Promise.resolve().then(async () => {
			if (!started) await reader?.return?.();
			await pumping;
		});
		controller.abort();
		options.signal.removeEventListener("abort", abort);
		listeners.clear();
		return closing;
	};
	try {
		signal.throwIfAborted();
		reader = transport.snapshots({ signal })[Symbol.asyncIterator]();
		const initial = await reader.next();
		signal.throwIfAborted();
		if (initial.done)
			throw new Error("UI snapshot stream ended before hydration");
		snapshot = parseUiSnapshot(initial.value);
	} catch (error) {
		try {
			await close();
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], "UI connection failed");
		}
		throw error;
	}
	const activeReader = reader;
	started = true;
	pumping = (async () => {
		try {
			while (!signal.aborted) {
				const item = await activeReader.next();
				if (signal.aborted) break;
				if (item.done) throw new Error("UI snapshot stream disconnected");
				const update = parseUiSnapshot(item.value);
				if (update.sequence <= snapshot.sequence) continue;
				snapshot = update;
				for (const listener of [...listeners]) listener.next(snapshot);
			}
		} catch (error) {
			if (!signal.aborted) {
				failure = { error };
				controller.abort(error);
				const errors = [error];
				for (const listener of [...listeners]) {
					try {
						listener.error(error);
					} catch (observerError) {
						errors.push(observerError);
					}
				}
				throw errors.length === 1
					? error
					: new AggregateError(errors, "UI connection observers failed");
			}
		} finally {
			options.signal.removeEventListener("abort", abort);
			listeners.clear();
			await activeReader.return?.();
		}
	})();
	// The owner observes cleanup errors through close(), not an unhandled rejection.
	void pumping.catch(() => {});
	function check() {
		if (failure) throw failure.error;
		signal.throwIfAborted();
	}
	return {
		closed: pumping,
		getSnapshot() {
			check();
			return snapshot;
		},
		subscribe(next, error) {
			check();
			const listener = { next, error };
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		async call(action, input, invocation): Promise<JsonValue> {
			check();
			const callSignal = AbortSignal.any([signal, invocation.signal]);
			callSignal.throwIfAborted();
			const result = await transport.call(action, input, {
				signal: callSignal,
			});
			callSignal.throwIfAborted();
			return result;
		},
		...(transport.stream
			? {
					async *stream(
						name: string,
						input: JsonValue,
						invocation: { signal: AbortSignal },
					) {
						check();
						const streamSignal = AbortSignal.any([signal, invocation.signal]);
						streamSignal.throwIfAborted();
						const stream = transport.stream;
						if (!stream)
							throw new Error("UI transport does not support streams");
						for await (const value of stream(name, input, {
							signal: streamSignal,
						})) {
							streamSignal.throwIfAborted();
							yield value;
						}
						streamSignal.throwIfAborted();
					},
				}
			: {}),
		close,
	};
}
