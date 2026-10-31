/** Authenticated, ordered frames; the transport bounds and buffers initial input. */
export interface VoiceHandoffChannel {
	send(message: unknown): void;
	onMessage(listener: (message: unknown) => void): () => void;
	onClose(listener: (error: Error) => void): () => void;
	close(): void;
}

/** Concurrent shutdown paths join one permission release, including its failure. */
export function ownVoiceGrant(grant: { release(): Promise<void> }): {
	release(): Promise<void>;
} {
	let releasing: Promise<void> | undefined;
	return {
		release: () =>
			(releasing ??= Promise.resolve().then(() => grant.release())),
	};
}

/** The browser keeps its origin and audio connection while its Durable conversation binding moves. */
export interface TransferredVoiceControls {
	readonly inputMuted: boolean;
	setInputMuted(muted: boolean): void;
	stop(): Promise<void>;
	/** Stop/start the selected call without discarding its source audio binding. */
	stopCall(): Promise<void>;
	startCall(): Promise<void>;
	sendText(text: string): Promise<void>;
	rpc(body: Record<string, unknown>): Promise<unknown>;
	onSessionEvent(listener: (event: string, data: unknown) => void): () => void;
}
