import { CdpClient } from "./client.ts";
import { waitForTurn } from "./serial.ts";
import type { ElementRefs } from "./types.ts";
import { asRecord } from "./types.ts";

const TAB_IDLE_MS = 20 * 60 * 1_000;

export interface ActiveTab {
	cdp: CdpClient;
	sessionId: string;
	elementRefs: ElementRefs;
	refId: string;
}

export class TabBridge {
	readonly elementRefs: ElementRefs = new Map();
	readonly targetId: string;
	readonly cdp: CdpClient;
	readonly sessionId: string;
	private tail = Promise.resolve();
	private idleTimer: ReturnType<typeof setTimeout> | undefined;
	private closed = false;
	private closing: Promise<void> | undefined;
	private backgroundRendering: boolean | undefined = false;
	private readonly onClose: () => void;

	private constructor(
		targetId: string,
		cdp: CdpClient,
		sessionId: string,
		onClose: () => void,
	) {
		this.targetId = targetId;
		this.cdp = cdp;
		this.sessionId = sessionId;
		this.onClose = onClose;
		this.resetIdle();
		cdp.onEvent("Target.targetDestroyed", (value) => {
			const event = asRecord(value, "target destroyed event");
			if (event["targetId"] === targetId) this.close(false);
		});
		cdp.onEvent("Target.detachedFromTarget", (value) => {
			const event = asRecord(value, "target detached event");
			if (event["sessionId"] === sessionId) this.close(false);
		});
		cdp.onClose(() => this.close(false));
	}

	static async connect(
		targetId: string,
		onClose: () => void,
		signal: AbortSignal | undefined,
		discover: (signal?: AbortSignal) => Promise<string>,
	): Promise<TabBridge> {
		const cdp = new CdpClient();
		try {
			await cdp.connect(await discover(signal), signal);
			const response = asRecord(
				await cdp.send(
					"Target.attachToTarget",
					{ targetId, flatten: true },
					undefined,
					signal,
				),
				"Target.attachToTarget response",
			);
			if (typeof response["sessionId"] !== "string") {
				throw new Error("Chrome did not return a tab session");
			}
			return new TabBridge(targetId, cdp, response["sessionId"], onClose);
		} catch (error) {
			cdp.close();
			throw error;
		}
	}

	async run<T>(
		refId: string,
		signal: AbortSignal | undefined,
		action: (tab: ActiveTab) => Promise<T>,
	): Promise<T> {
		if (this.closed) throw new Error("Tab bridge is closed");
		let release!: () => void;
		const turn = new Promise<void>((resolveValue) => {
			release = resolveValue;
		});
		const previous = this.tail;
		this.tail = previous.then(
			() => turn,
			() => turn,
		);
		try {
			await waitForTurn(previous, signal);
			if (this.closed) throw new Error("Tab bridge is closed");
			this.resetIdle();
			return await action({
				cdp: this.cdp,
				sessionId: this.sessionId,
				elementRefs: this.elementRefs,
				refId,
			});
		} finally {
			release();
		}
	}

	async setBackgroundRendering(
		enabled: boolean,
		signal?: AbortSignal,
	): Promise<void> {
		if (this.backgroundRendering === enabled) return;
		// An interrupted command may already have applied. Keep the state unknown
		// until Chrome acknowledges it, so the next action reestablishes it.
		this.backgroundRendering = undefined;
		await this.cdp.send(
			"Emulation.setFocusEmulationEnabled",
			{ enabled },
			this.sessionId,
			signal,
		);
		this.backgroundRendering = enabled;
	}

	close(detach = true): Promise<void> {
		if (this.closing) return this.closing;
		if (this.closed) return Promise.resolve();
		this.closed = true;
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.elementRefs.clear();
		if (detach) {
			this.closing = this.cdp
				.send(
					"Target.detachFromTarget",
					{ sessionId: this.sessionId },
					undefined,
					undefined,
				)
				.then(() => undefined)
				.catch(() => undefined)
				.finally(() => this.cdp.close());
		} else {
			this.cdp.close();
			this.closing = Promise.resolve();
		}
		this.onClose();
		return this.closing;
	}

	private resetIdle(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => this.close(), TAB_IDLE_MS);
		this.idleTimer.unref?.();
	}
}
