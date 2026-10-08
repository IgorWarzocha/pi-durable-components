export type JsonValue =
	| null
	| boolean
	| number
	| string
	| readonly JsonValue[]
	| { readonly [key: string]: JsonValue };

/** Trusted in-process UI. call transport and authorization belong to the host. */
export interface UiContext {
	id: string;
	revision: string;
	signal: AbortSignal;
	call(method: string, input: JsonValue): Promise<JsonValue>;
}
export type UiCleanup = () => void | Promise<void>;
export type UiMount = (
	container: HTMLElement,
	context: UiContext,
) => UiCleanup | Promise<UiCleanup>;
export interface UiSession {
	/** Rejects on failed mount or disposal before mount completes. */
	ready: Promise<void>;
	/** Observe failures here, including automatic parent-signal cleanup. */
	closed: Promise<void>;
	dispose(): Promise<void>;
}

/** Own one mount, its child signal, and exactly one cleanup, including late mounts. */
export function mountUi(
	mount: UiMount,
	container: HTMLElement,
	context: UiContext,
): UiSession {
	const controller = new AbortController();
	let finish!: () => void;
	let fail!: (error: unknown) => void;
	const closed = new Promise<void>((resolve, reject) => {
		finish = resolve;
		fail = reject;
	});
	// The host can attach its closed observer after mountUi returns.
	void closed.catch(() => {});
	let disposing: Promise<void> | undefined;
	const mounted = Promise.resolve().then(async () => {
		if (controller.signal.aborted) return undefined;
		const cleanup = await mount(container, {
			...context,
			signal: controller.signal,
			async call(method, input) {
				controller.signal.throwIfAborted();
				const result = await context.call(method, input);
				// This suppresses stale results, not remote side effects or in-flight IO.
				controller.signal.throwIfAborted();
				return result;
			},
		});
		if (typeof cleanup !== "function")
			throw new TypeError("UI mount must return a cleanup function");
		return cleanup;
	});
	const dispose = () => {
		if (disposing) return disposing;
		controller.abort();
		context.signal.removeEventListener("abort", abort);
		disposing = mounted
			.then((cleanup) => cleanup?.())
			.then(finish, (error: unknown) => {
				fail(error);
				throw error;
			});
		return disposing;
	};
	const abort = () => {
		void dispose().catch(() => {});
	};
	context.signal.addEventListener("abort", abort, { once: true });
	if (context.signal.aborted) abort();
	const ready = mounted.then(() => {
		controller.signal.throwIfAborted();
	});
	void ready.catch((error: unknown) => {
		if (!controller.signal.aborted) {
			controller.abort();
			context.signal.removeEventListener("abort", abort);
			fail(error);
		}
	});
	return { ready, closed, dispose };
}

export { themeCss } from "./theme.ts";
