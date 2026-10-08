import {
	type JsonValue,
	mountUi,
	type UiCleanup,
	type UiSession,
} from "./lifecycle.ts";

export interface UiSnapshot {
	sequence: number;
	value: JsonValue;
}

/** Validate wire snapshots without trusting a transport's TypeScript types. */
export function parseUiSnapshot(value: unknown): UiSnapshot {
	if (
		typeof value !== "object" ||
		value === null ||
		!("sequence" in value) ||
		!("value" in value)
	)
		throw new TypeError("Expected a UI snapshot");
	const sequence = value.sequence;
	if (
		typeof sequence !== "number" ||
		!Number.isSafeInteger(sequence) ||
		sequence < 0
	)
		throw new TypeError(
			"UI snapshot sequence must be a nonnegative safe integer",
		);
	assertJson(value.value, new Set());
	return { sequence, value: value.value };
}

function assertJson(
	value: unknown,
	ancestors: Set<object>,
): asserts value is JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean")
		return;
	if (typeof value === "number" && Number.isFinite(value)) return;
	if (typeof value !== "object" || value === null || ancestors.has(value))
		throw new TypeError("UI snapshot value must be JSON");
	if (
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) !== Object.prototype &&
		Object.getPrototypeOf(value) !== null
	)
		throw new TypeError("UI snapshot value must be JSON");
	ancestors.add(value);
	if (Array.isArray(value)) {
		for (const entry of value) assertJson(entry, ancestors);
	} else {
		for (const entry of Object.values(value)) assertJson(entry, ancestors);
	}
	ancestors.delete(value);
}

/** Host-owned state and transport. Sequence numbers must be nonnegative safe integers. */
export interface UiBinding {
	getSnapshot(): UiSnapshot;
	subscribe(
		onSnapshot: (snapshot: UiSnapshot) => void,
		onError: (error: unknown) => void,
	): UiCleanup;
	call(
		action: string,
		input: JsonValue,
		options: { signal: AbortSignal },
	): Promise<JsonValue>;
	stream?(
		name: string,
		input: JsonValue,
		options: { signal: AbortSignal },
	): AsyncIterable<JsonValue>;
}

export interface UiComponentContext<State> {
	id: string;
	signal: AbortSignal;
	state: {
		getSnapshot(): State;
		subscribe(listener: () => void): () => void;
	};
	call(
		action: string,
		input: JsonValue,
		options?: { signal?: AbortSignal },
	): Promise<JsonValue>;
	stream(
		name: string,
		input: JsonValue,
		options?: { signal?: AbortSignal },
	): AsyncIterable<JsonValue>;
}

export interface UiComponent<State> {
	id: string;
	/** Contract version, not a state revision. */
	version: number;
	parseState(value: JsonValue): State;
	mount(
		container: HTMLElement,
		context: UiComponentContext<State>,
	): UiCleanup | Promise<UiCleanup>;
	actions: readonly string[];
	streams: readonly string[];
}

/** Mount trusted code against one host binding. No calls or streams are replayed. */
export function mountComponent<State>(
	component: UiComponent<State>,
	container: HTMLElement,
	options: { id: string; signal: AbortSignal; binding: UiBinding },
): UiSession {
	const actions = new Set(component.actions);
	const streams = new Set(component.streams);
	const binding = options.binding;
	let session: UiSession;
	session = mountUi(
		async (_container, base) => {
			const signal = base.signal;
			const listeners = new Set<() => void>();
			const iterators = new Map<
				AsyncIterator<JsonValue>,
				Promise<void> | undefined
			>();
			const pending = new Set<Promise<void>>();
			const errors: unknown[] = [];
			let unsubscribe: UiCleanup | undefined;
			let sequence = -1;
			let state: State;
			const track = (cleanup: UiCleanup) => {
				try {
					const task = Promise.resolve(cleanup())
						.catch((error: unknown) => {
							errors.push(error);
						})
						.finally(() => {
							pending.delete(task);
						});
					pending.add(task);
				} catch (error) {
					errors.push(error);
				}
			};
			const closeIterator = (iterator: AsyncIterator<JsonValue>) => {
				const existing = iterators.get(iterator);
				if (existing) return existing;
				// Defer invocation so reentrant disposal sees the recorded close promise.
				const closing = Promise.resolve().then(async () => {
					await iterator.return?.();
				});
				iterators.set(iterator, closing);
				track(() => closing);
				return closing;
			};
			const release = () => {
				listeners.clear();
				const cleanup = unsubscribe;
				unsubscribe = undefined;
				if (cleanup) track(cleanup);
				for (const iterator of iterators.keys()) void closeIterator(iterator);
			};
			const finish = async () => {
				release();
				signal.removeEventListener("abort", release);
				await Promise.all(pending);
				if (errors.length)
					throw new AggregateError(errors, "UI component session failed");
			};
			const fail = (error: unknown) => {
				if (signal.aborted) return;
				errors.push(error);
				void session.dispose().catch(() => {});
			};
			const accept = (snapshot: UiSnapshot) => {
				if (signal.aborted) return;
				try {
					const validated = parseUiSnapshot(snapshot);
					if (validated.sequence <= sequence) return;
					const parsed = component.parseState(validated.value);
					state = parsed;
					sequence = validated.sequence;
					for (const listener of [...listeners]) {
						if (signal.aborted) break;
						listener();
					}
				} catch (error) {
					fail(error);
				}
			};
			signal.addEventListener("abort", release, { once: true });
			let cleanup: UiCleanup;
			try {
				unsubscribe = binding.subscribe(accept, fail);
				if (typeof unsubscribe !== "function")
					throw new TypeError("UI binding must return a cleanup function");
				signal.throwIfAborted();
				// subscribe may synchronously publish a newer snapshot than getSnapshot returns.
				accept(binding.getSnapshot());
				signal.throwIfAborted();
				const context: UiComponentContext<State> = {
					id: options.id,
					signal,
					state: {
						getSnapshot() {
							signal.throwIfAborted();
							return state;
						},
						subscribe(listener) {
							signal.throwIfAborted();
							listeners.add(listener);
							return () => {
								listeners.delete(listener);
							};
						},
					},
					async call(action, input, options) {
						const requestSignal = options?.signal
							? AbortSignal.any([signal, options.signal])
							: signal;
						requestSignal.throwIfAborted();
						if (!actions.has(action))
							throw new Error(`Undeclared UI action: ${action}`);
						const result = await binding.call(action, input, {
							signal: requestSignal,
						});
						requestSignal.throwIfAborted();
						return result;
					},
					async *stream(name, input, options) {
						const requestSignal = options?.signal
							? AbortSignal.any([signal, options.signal])
							: signal;
						requestSignal.throwIfAborted();
						if (!streams.has(name))
							throw new Error(`Undeclared UI stream: ${name}`);
						if (!binding.stream)
							throw new Error("UI binding does not support streams");
						const iterator = binding
							.stream(name, input, { signal: requestSignal })
							[Symbol.asyncIterator]();
						iterators.set(iterator, undefined);
						const cancel = () => {
							void closeIterator(iterator).catch(() => {});
						};
						requestSignal.addEventListener("abort", cancel, { once: true });
						if (requestSignal.aborted) cancel();
						try {
							while (true) {
								requestSignal.throwIfAborted();
								const next = await iterator.next();
								requestSignal.throwIfAborted();
								if (next.done) break;
								yield next.value;
							}
						} finally {
							requestSignal.removeEventListener("abort", cancel);
							try {
								await closeIterator(iterator);
							} finally {
								iterators.delete(iterator);
							}
						}
					},
				};
				cleanup = await component.mount(_container, context);
				if (typeof cleanup !== "function")
					throw new TypeError("UI mount must return a cleanup function");
			} catch (error) {
				errors.push(error);
				void session.dispose().catch(() => {});
				await finish();
				throw error;
			}
			return async () => {
				track(cleanup);
				await finish();
			};
		},
		container,
		{
			id: options.id,
			revision: String(component.version),
			signal: options.signal,
			call: (action, input) =>
				binding.call(action, input, { signal: options.signal }),
		},
	);
	return session;
}
