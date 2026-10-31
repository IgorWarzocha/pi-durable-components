import type { VoiceCall } from "./controller.ts";

/** One selected session retains its authenticated audio binding between calls. */
export class RetainedVoiceCall {
	call: VoiceCall | undefined;
	stopped = false;
	private abort = new AbortController();
	private starting: Promise<void> | undefined;
	private readonly options: {
		signal: AbortSignal;
		create(signal: AbortSignal): VoiceCall;
		reload(): Promise<void>;
		activate(call: VoiceCall): Promise<void>;
		beforeStop(): void;
		onStopped(): void;
	};
	constructor(options: RetainedVoiceCall["options"]) {
		this.options = options;
	}

	async initial(start: (call: VoiceCall) => Promise<void>): Promise<void> {
		const call = this.options.create(
			AbortSignal.any([this.options.signal, this.abort.signal]),
		);
		this.call = call;
		this.starting = start(call);
		try {
			await this.starting;
		} catch (error) {
			if (
				!this.stopped ||
				!this.abort.signal.aborted ||
				this.options.signal.aborted
			)
				throw error;
		} finally {
			this.starting = undefined;
		}
	}

	async stop(): Promise<void> {
		this.stopped = true;
		this.options.beforeStop();
		this.abort.abort();
		const call = this.call;
		await call?.close();
		await this.starting?.catch(() => {});
		if (this.call === call) this.call = undefined;
		this.options.onStopped();
	}

	start(): Promise<void> {
		if (this.starting) return this.starting;
		if (!this.stopped) return Promise.resolve();
		this.abort = new AbortController();
		this.stopped = false;
		const signal = AbortSignal.any([this.options.signal, this.abort.signal]);
		this.starting = (async () => {
			try {
				await this.options.reload();
				signal.throwIfAborted();
				this.call = this.options.create(signal);
				await this.options.activate(this.call);
			} catch (error) {
				this.stopped = true;
				this.options.beforeStop();
				await this.call?.close();
				this.call = undefined;
				throw error;
			} finally {
				this.starting = undefined;
			}
		})();
		return this.starting;
	}

	detach(): void {
		this.call = undefined;
	}
	async shutdown(): Promise<void> {
		this.abort.abort();
		await this.call?.close();
		await this.starting?.catch(() => {});
		this.call = undefined;
	}
}
