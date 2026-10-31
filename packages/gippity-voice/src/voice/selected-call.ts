/** Stop interrupts startup before joining the selected session's operation queue. */
export class SelectedVoiceCall {
	private paused = false;
	private closed = false;
	private operation = Promise.resolve();
	private restarting: AbortController | undefined;
	private generation = 0;
	private readonly options: {
		active(): boolean;
		cancelStartup(): void;
		stop(): Promise<void>;
		start(signal: AbortSignal): Promise<void>;
	};
	constructor(options: SelectedVoiceCall["options"]) {
		this.options = options;
	}
	private serialize(action: () => Promise<void>): Promise<void> {
		const result = this.operation.then(() => {
			if (this.closed) throw new Error("Selected voice connection closed");
			return action();
		});
		this.operation = result.catch(() => {});
		return result;
	}
	stop(): Promise<void> {
		this.generation++;
		this.restarting?.abort();
		this.options.cancelStartup();
		return this.serialize(async () => {
			this.paused = true;
			await this.options.stop();
		});
	}
	start(): Promise<void> {
		const generation = this.generation;
		return this.serialize(async () => {
			if (generation !== this.generation)
				throw new Error("Selected-session voice start cancelled by Stop");
			if (!this.paused) return;
			if (this.options.active())
				throw new Error(
					"Selected session already has an active voice call; stop it before restarting this call",
				);
			const restarting = new AbortController();
			this.restarting = restarting;
			try {
				await this.options.start(restarting.signal);
				this.paused = false;
			} finally {
				if (this.restarting === restarting) this.restarting = undefined;
			}
		});
	}
	cancel(): void {
		this.closed = true;
		this.restarting?.abort();
	}
}
