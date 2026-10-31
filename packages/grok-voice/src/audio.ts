export interface AudioCallbacks {
	onAudio(pcm: Buffer): void;
	onError(error: Error): void;
}

export interface RealtimeAudio {
	start(callbacks: AudioCallbacks): Promise<void>;
	play(pcm: Buffer): void;
	clear(): void;
	drain(): Promise<void>;
	setMuted(muted: boolean): void;
	close(): Promise<void>;
	/** Optional retained handoff-binding lifecycle. Native audio needs no implementation. */
	stopCall?(): void;
	resumeCall?(): void;
	disconnect?(): void;
}
