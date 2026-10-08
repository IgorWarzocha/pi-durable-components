import type { UiBinding, UiComponentContext } from "./binding.ts";
import { bindCapability } from "./capability.ts";

export {
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
	let session: UiSession;
	session = ownUiSession(async (signal) => {
		const instance = await bindCapability(
			{ ...component, presentations: [] },
			{ ...options, signal },
		);
		void instance.closed.catch(() => session.dispose().catch(() => {}));
		try {
			const cleanup = await component.mount(container, instance.context);
			if (typeof cleanup !== "function")
				throw new TypeError("UI mount must return a cleanup function");
			return async () => {
				try {
					await cleanup();
				} finally {
					await instance.dispose();
				}
			};
		} catch (error) {
			await instance.dispose();
			throw error;
		}
	}, options.signal);
	return session;
}
