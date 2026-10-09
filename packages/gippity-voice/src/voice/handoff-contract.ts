/** Authenticated, ordered frames; the transport bounds and buffers initial input. */
export interface VoiceHandoffChannel {
	send(message: unknown): void;
	onMessage(listener: (message: unknown) => void): () => void;
	onClose(listener: (error: Error) => void): () => void;
	close(): void;
}

/** The browser keeps its origin and audio connection while its Durable conversation binding moves. */
export interface TransferredVoiceControls {
	readonly inputMuted: boolean;
	setInputMuted(muted: boolean): void;
	stop(): Promise<void>;
	sendText(text: string): Promise<void>;
	rpc(body: Record<string, unknown>): Promise<unknown>;
	onSessionEvent(listener: (event: string, data: unknown) => void): () => void;
}
