import {
	parseUiSnapshot,
	type UiBinding,
	type UiComponentContext,
	type UiSnapshot,
} from "./binding.ts";
import {
	type JsonValue,
	ownUiSession,
	type UiCleanup,
	type UiSession,
} from "./lifecycle.ts";
import {
	createPresentation,
	type UiPresentation,
	type UiPresentationContext,
	type UiPresentationOptions,
	type UiPresentationSession,
} from "./presentation.ts";

export interface UiCapability<State> {
	id: string;
	version: number;
	parseState(value: JsonValue): State;
	actions: readonly string[];
	streams: readonly string[];
	presentations: readonly string[];
}
export interface UiCapabilityInstance<State> {
	capability: UiCapability<State>;
	context: UiComponentContext<State>;
	closed: Promise<void>;
	dispose(): Promise<void>;
	present<Model>(
		presentation: UiPresentation<State, Model>,
		options: UiPresentationOptions,
	): UiPresentationSession<Model>;
}

const ownedChildren = new WeakMap<object, Set<UiSession>>();

/** Internal ownership registration for optional renderers. */
function ownCapabilityChild(instance: object, child: UiSession): void {
	const children = ownedChildren.get(instance);
	if (!children) throw new Error("Unknown UI capability instance");
	children.add(child);
	void child.closed.catch(() => {}).finally(() => children.delete(child));
}

export async function bindCapability<State>(
	capability: UiCapability<State>,
	options: { id: string; signal: AbortSignal; binding: UiBinding },
): Promise<UiCapabilityInstance<State>> {
	const actions = new Set(capability.actions);
	const streams = new Set(capability.streams);
	const binding = options.binding;
	const children = new Set<UiSession>();
	let context!: UiComponentContext<State>;
	let revision!: () => number;
	let session: UiSession;
	session = ownUiSession(async (signal) => {
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
			for (const child of children) track(() => child.dispose());
			children.clear();
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
				const parsed = capability.parseState(validated.value);
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

		try {
			unsubscribe = binding.subscribe(accept, fail);
			if (typeof unsubscribe !== "function")
				throw new TypeError("UI binding must return a cleanup function");
			signal.throwIfAborted();
			// subscribe may synchronously publish a newer snapshot than getSnapshot returns.
			accept(binding.getSnapshot());
			signal.throwIfAborted();
			context = {
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
			revision = () => sequence;
		} catch (error) {
			errors.push(error);
			void session.dispose().catch(() => {});
			await finish();
			throw error;
		}
		return async () => {
			await finish();
		};
	}, options.signal);
	await session.ready;
	const instance: UiCapabilityInstance<State> = {
		capability,
		context,
		closed: session.closed,
		dispose: session.dispose,
		present(presentation, viewOptions) {
			context.signal.throwIfAborted();
			if (!capability.presentations.includes(presentation.id))
				throw new Error(`Undeclared UI presentation: ${presentation.id}`);
			const view = createPresentation(
				presentation,
				context,
				revision,
				capability.presentations,
				viewOptions,
			);
			ownCapabilityChild(instance, view);
			return view;
		},
	};
	ownedChildren.set(instance, children);
	return instance;
}

/** Optional DOM renderer. Disposing it owns its view, never the shared capability. */
export function mountPresentation<State, Model>(
	presentation: UiPresentation<State, Model>,
	container: HTMLElement,
	options: UiPresentationOptions & {
		instance: UiCapabilityInstance<State>;
		mount(
			container: HTMLElement,
			context: UiPresentationContext<Model>,
		): UiCleanup | Promise<UiCleanup>;
	},
): UiSession {
	let session: UiSession;
	session = ownUiSession(
		async (signal) => {
			const view = options.instance.present(presentation, {
				...options,
				signal,
			});
			void view.closed.catch(() => session.dispose().catch(() => {}));
			try {
				await view.ready;
				const cleanup = await options.mount(container, view.context);
				if (typeof cleanup !== "function")
					throw new TypeError("UI mount must return a cleanup function");
				return async () => {
					try {
						await cleanup();
					} finally {
						await view.dispose();
					}
				};
			} catch (error) {
				await view.dispose();
				throw error;
			}
		},
		AbortSignal.any([options.signal, options.instance.context.signal]),
	);
	ownCapabilityChild(options.instance, session);
	return session;
}
