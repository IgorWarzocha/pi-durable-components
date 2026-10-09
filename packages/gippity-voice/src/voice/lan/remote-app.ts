import { remoteJsonValue } from "./remote-json.ts";

export interface GippityRemoteAppProvider {
	id: string;
	/** An approved app-files root in the conversation namespace. */
	root: string;
	snapshot(): unknown;
	subscribe(
		listener: (
			update:
				| { state: unknown; event?: never; data?: never }
				| { event: string; data: unknown; state?: never },
		) => void,
	): () => void;
}
export interface GippityRemoteAppMessage {
	type: "app.state" | "app.event";
	app: string;
	event?: string;
	data: unknown;
}

/** One active application provider, matching the source's replacement semantics. */
export class GippityRemoteApps {
	private provider: GippityRemoteAppProvider | undefined;
	private unsubscribe: (() => void) | undefined;
	private readonly listeners = new Set<
		(message: GippityRemoteAppMessage) => void
	>();
	register(provider: GippityRemoteAppProvider): () => void {
		if (
			!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(provider.id) ||
			!provider.root ||
			Buffer.byteLength(provider.root) > 512
		)
			throw new Error("Invalid remote app id or root");
		const initial = this.message(provider, { state: provider.snapshot() });
		const unsubscribe = provider.subscribe((update) => {
			if (this.provider !== provider) return;
			const value = this.message(provider, update);
			for (const listener of this.listeners) listener(value);
		});
		this.unsubscribe?.();
		this.provider = provider;
		this.unsubscribe = unsubscribe;
		for (const listener of this.listeners) listener(initial);
		return () => {
			if (this.provider === provider) {
				this.unsubscribe?.();
				this.unsubscribe = undefined;
				this.provider = undefined;
			}
		};
	}
	apps() {
		return this.provider
			? [{ id: this.provider.id, path: `/_gippity/apps/${this.provider.id}/` }]
			: [];
	}
	root(id: string) {
		return this.provider?.id === id ? this.provider.root : undefined;
	}
	snapshot() {
		return this.provider
			? this.message(this.provider, { state: this.provider.snapshot() })
			: undefined;
	}
	onMessage(listener: (message: GippityRemoteAppMessage) => void) {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	close() {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.provider = undefined;
	}
	private message(
		provider: GippityRemoteAppProvider,
		update: { state?: unknown; event?: string; data?: unknown },
	): GippityRemoteAppMessage {
		if (
			(update.event === undefined) !== "state" in update ||
			(update.event !== undefined &&
				!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(update.event))
		)
			throw new Error("Invalid remote app update");
		const message: GippityRemoteAppMessage = {
			type: update.event === undefined ? "app.state" : "app.event",
			app: provider.id,
			...(update.event !== undefined ? { event: update.event } : {}),
			data: remoteJsonValue(
				update.event === undefined ? update.state : update.data,
			),
		};
		if (Buffer.byteLength(JSON.stringify(message)) > 64 * 1024)
			throw new Error("Remote app update is too large");
		return message;
	}
}
