import type { UiComponentContext } from "./binding.ts";
import { ownUiSession, type UiSession } from "./lifecycle.ts";

/** Semantic projection, independent of rendering or placement. */
export interface UiPresentation<State, Model> {
	id: string;
	select(state: State): Model;
	requests: readonly string[];
}
export interface UiPresentationOptions {
	signal: AbortSignal;
	onRequestPresentation?: (
		id: string,
		options: { signal: AbortSignal },
	) => void | Promise<void>;
}
export interface UiPresentationContext<Model>
	extends UiComponentContext<Model> {
	requestPresentation(id: string): Promise<void>;
}
export interface UiPresentationSession<Model> extends UiSession {
	context: UiPresentationContext<Model>;
}

/** Internal view owner. A projection failure closes only this view. */
export function createPresentation<State, Model>(
	presentation: UiPresentation<State, Model>,
	source: UiComponentContext<State>,
	revision: () => number,
	presentations: readonly string[],
	options: UiPresentationOptions,
): UiPresentationSession<Model> {
	const controller = new AbortController();
	const signal = AbortSignal.any([
		source.signal,
		options.signal,
		controller.signal,
	]);
	const listeners = new Set<() => void>();
	const iterators = new Set<AsyncIterator<unknown>>();
	let sequence = -1;
	let model: Model;
	let failure: unknown;
	let failed = false;
	let unsubscribe: (() => void) | undefined;
	let session: UiSession;
	const select = () => {
		signal.throwIfAborted();
		if (sequence !== revision()) {
			try {
				model = presentation.select(source.state.getSnapshot());
				sequence = revision();
			} catch (error) {
				failure = error;
				failed = true;
				controller.abort();
				throw error;
			}
		}
		return model;
	};
	const update = () => {
		try {
			select();
			for (const listener of [...listeners]) {
				if (signal.aborted) break;
				listener();
			}
		} catch (error) {
			failure = error;
			failed = true;
			controller.abort();
		}
	};
	// Hydrate synchronously for framework getSnapshot consumers.
	select();
	unsubscribe = source.state.subscribe(update);
	const release = () => {
		unsubscribe?.();
		unsubscribe = undefined;
		listeners.clear();
	};
	signal.addEventListener("abort", release, { once: true });
	session = ownUiSession(
		() => async () => {
			release();
			signal.removeEventListener("abort", release);
			const results = await Promise.allSettled(
				[...iterators].map((iterator) => iterator.return?.()),
			);
			const errors = results.flatMap((result) =>
				result.status === "rejected" ? [result.reason] : [],
			);
			if (failed) errors.unshift(failure);
			if (errors.length)
				throw new AggregateError(errors, "UI presentation failed");
		},
		signal,
		// This start only supplies cleanup for resources already acquired above.
		{ startWhenAborted: true },
	);
	const context: UiPresentationContext<Model> = {
		id: source.id,
		signal,
		state: {
			getSnapshot: select,
			subscribe(listener) {
				signal.throwIfAborted();
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
		},
		call(action, input, request) {
			return source.call(action, input, {
				signal: request?.signal
					? AbortSignal.any([signal, request.signal])
					: signal,
			});
		},
		async *stream(name, input, request) {
			const iterator = source
				.stream(name, input, {
					signal: request?.signal
						? AbortSignal.any([signal, request.signal])
						: signal,
				})
				[Symbol.asyncIterator]();
			iterators.add(iterator);
			try {
				while (true) {
					const next = await iterator.next();
					if (next.done) break;
					yield next.value;
				}
			} finally {
				try {
					await iterator.return?.();
				} finally {
					iterators.delete(iterator);
				}
			}
		},
		async requestPresentation(id) {
			signal.throwIfAborted();
			if (!presentation.requests.includes(id) || !presentations.includes(id))
				throw new Error(`Undeclared UI presentation request: ${id}`);
			if (!options.onRequestPresentation)
				throw new Error("UI host does not handle presentation requests");
			await options.onRequestPresentation(id, { signal });
			signal.throwIfAborted();
		},
	};
	const closed = session.closed.then(() => {
		if (failed) throw failure;
	});
	void closed.catch(() => {});
	return {
		...session,
		closed,
		context,
		async dispose() {
			controller.abort();
			await session.dispose();
			await closed;
		},
	};
}
