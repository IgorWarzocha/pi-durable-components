import { CdpClient } from "./client.ts";
import {
	getDisplayPrefixLength,
	getWebSocketUrl,
	resolvePrefix,
} from "./discovery.ts";
import { waitForTurn } from "./serial.ts";
import { type ActiveTab, TabBridge } from "./tab-bridge.ts";
import { BrowserTabs } from "./tabs.ts";
import type { PageInfo } from "./types.ts";

interface PendingConnection<T> {
	controller: AbortController;
	promise: Promise<T>;
	value?: T;
}

interface BrowserConnection {
	cdp: CdpClient;
	tabs: BrowserTabs;
}

export class BrowserCdpSession {
	private closing: Promise<void> | undefined;
	private root: BrowserConnection | undefined;
	private rootPending: PendingConnection<BrowserConnection> | undefined;
	private readonly ownerId: string;
	private readonly ownershipDirectory: string;
	private readonly tabs = new Map<string, TabBridge>();
	private readonly tabPromises = new Map<
		string,
		PendingConnection<TabBridge>
	>();

	private readonly discover: typeof getWebSocketUrl;
	constructor(
		ownerId: string,
		ownershipDirectory: string,
		discover = getWebSocketUrl,
	) {
		this.discover = discover;
		this.ownerId = ownerId;
		this.ownershipDirectory = ownershipDirectory;
	}

	async pages(signal?: AbortSignal): Promise<PageInfo[]> {
		return (await this.rootConnection(signal)).tabs.list(signal);
	}

	async open(
		url: string,
		signal?: AbortSignal,
	): Promise<{
		refId: string;
	}> {
		return (await this.rootConnection(signal)).tabs.open(url, signal);
	}

	async show(refId: string, signal?: AbortSignal): Promise<string> {
		return (await this.rootConnection(signal)).tabs.show(refId, signal);
	}

	async closeTab(refId: string, signal?: AbortSignal): Promise<string> {
		const root = await this.rootConnection(signal);
		const resolved = await root.tabs.resolve(refId, signal);
		const targetId = resolved.page.targetId;
		this.stopPendingTab(targetId, "Tab is closing");
		const bridge = this.tabs.get(targetId);
		const close = () => root.tabs.close(targetId, signal);
		const closed = bridge
			? await bridge.run(resolved.refId, signal, close)
			: await close();
		bridge?.close(false);
		return closed.refId;
	}

	async withTab<T>(
		refId: string,
		signal: AbortSignal | undefined,
		action: (tab: ActiveTab) => Promise<T>,
	): Promise<T> {
		const pages = await this.pages(signal);
		const targetId = resolvePrefix(
			refId,
			pages.map((page) => page.targetId),
			"target",
			"Run tabs.",
		);
		let bridge = this.tabs.get(targetId);
		if (!bridge) {
			let pending = this.tabPromises.get(targetId);
			if (!pending) {
				const controller = new AbortController();
				const promise = this.connectTab(targetId, controller.signal);
				pending = { controller, promise };
				this.tabPromises.set(targetId, pending);
				void promise.then(
					(value) => {
						pending!.value = value;
					},
					() => {
						if (this.tabPromises.get(targetId) === pending) {
							this.tabPromises.delete(targetId);
						}
					},
				);
			}
			const connected = await waitForTurn(pending.promise, signal);
			bridge = this.tabs.get(targetId);
			if (!bridge) {
				if (this.tabPromises.get(targetId) !== pending) {
					connected.close();
					throw new Error("Tab bridge was stopped while connecting");
				}
				this.tabPromises.delete(targetId);
				this.tabs.set(targetId, connected);
				bridge = connected;
			} else if (bridge !== connected) {
				connected.close();
			}
		}
		const prefixLength = getDisplayPrefixLength(
			pages.map((page) => page.targetId),
		);
		const owned = pages.some(
			(page) => page.targetId === targetId && page.owned === true,
		);
		const current = bridge;
		return current.run(targetId.slice(0, prefixLength), signal, async (tab) => {
			await current.setBackgroundRendering(owned, signal);
			return action(tab);
		});
	}

	async stop(refId?: string): Promise<void> {
		if (!refId) {
			for (const targetId of this.tabPromises.keys()) {
				this.stopPendingTab(targetId, "All tab bridges were stopped");
			}
			await Promise.all(
				[...this.tabs.values()].map((bridge) => bridge.close()),
			);
			this.tabs.clear();
			return;
		}
		const pages = await this.pages();
		const targetId = resolvePrefix(
			refId,
			pages.map((page) => page.targetId),
			"target",
		);
		this.stopPendingTab(targetId, "Tab bridge " + refId + " was stopped");
		await this.tabs.get(targetId)?.close();
		this.tabs.delete(targetId);
	}

	close(): Promise<void> {
		if (this.closing) return this.closing;
		const pendingTabs = [...this.tabPromises.values()].map((pending) =>
			pending.promise.then(
				(bridge) => bridge.close(),
				() => undefined,
			),
		);
		for (const targetId of this.tabPromises.keys()) {
			this.stopPendingTab(targetId, "Browser session closed");
		}
		const closingTabs = [...this.tabs.values()].map((bridge) => bridge.close());
		this.tabs.clear();
		const rootPending = this.rootPending;
		this.rootPending = undefined;
		rootPending?.controller.abort(new Error("Browser session closed"));
		const root = this.root;
		this.root = undefined;
		this.closing = (async () => {
			await Promise.all([...pendingTabs, ...closingTabs]);
			const connected = await rootPending?.promise.catch(() => undefined);
			for (const connection of new Set([root, connected])) {
				if (!connection) continue;
				try {
					await connection.tabs.shutdown();
				} finally {
					connection.cdp.close();
				}
			}
		})();
		return this.closing;
	}

	private async rootConnection(
		signal?: AbortSignal,
	): Promise<BrowserConnection> {
		if (this.closing) throw new Error("Browser session closed");
		if (this.root) return this.root;
		let pending = this.rootPending;
		if (!pending) {
			const controller = new AbortController();
			const promise = this.connectRoot(controller.signal);
			pending = { controller, promise };
			this.rootPending = pending;
			void promise.then(
				(value) => {
					pending!.value = value;
					if (this.rootPending === pending) this.rootPending = undefined;
				},
				() => {
					if (this.rootPending === pending) this.rootPending = undefined;
				},
			);
		}
		return waitForTurn(pending.promise, signal);
	}

	private async connectTab(
		targetId: string,
		signal?: AbortSignal,
	): Promise<TabBridge> {
		let bridge: TabBridge | undefined;
		bridge = await TabBridge.connect(
			targetId,
			() => {
				if (bridge && this.tabs.get(targetId) === bridge) {
					this.tabs.delete(targetId);
				}
				const pending = this.tabPromises.get(targetId);
				if (bridge && pending?.value === bridge) {
					this.tabPromises.delete(targetId);
				}
			},
			signal,
			this.discover,
		);
		return bridge;
	}

	private stopPendingTab(targetId: string, message: string): void {
		const pending = this.tabPromises.get(targetId);
		if (!pending) return;
		this.tabPromises.delete(targetId);
		pending.controller.abort(new Error(message));
		void pending.promise.then(
			(bridge) => bridge.close(),
			() => undefined,
		);
	}

	private async connectRoot(signal: AbortSignal): Promise<BrowserConnection> {
		const client = new CdpClient();
		const url = await this.discover(signal);
		try {
			await client.connect(url, signal);
			signal.throwIfAborted();
			if (this.closing) throw new Error("Browser session closed");
		} catch (error) {
			client.close();
			throw error;
		}
		const connection = {
			cdp: client,
			tabs: new BrowserTabs(client, this.ownerId, this.ownershipDirectory, url),
		};
		this.root = connection;
		client.onClose(() => {
			if (this.root !== connection) return;
			this.root = undefined;
		});
		return connection;
	}
}
