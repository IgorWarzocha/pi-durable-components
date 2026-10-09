import type { AudioCallbacks, RealtimeAudio } from "./audio.ts";

/** Host-authenticated, ordered, bounded frames. No transport is silently created. */
export interface VoiceHandoffChannel {
	send(message: unknown): void;
	onMessage(listener: (message: unknown) => void): () => void;
	onClose(listener: (error: Error) => void): () => void;
	close(): void;
}
export interface TransferredVoiceControls {
	readonly inputMuted: boolean;
	setInputMuted(muted: boolean): void;
	stop(): Promise<void>;
	sendText(text: string): Promise<void>;
	rpc(body: Record<string, unknown>): Promise<unknown>;
	onSessionEvent(listener: (event: string, data: unknown) => void): () => void;
}
export interface CapturedHandoff {
	audio: RealtimeAudio;
	inputMuted: boolean;
	alternateVoice: boolean;
	sourceActive(): boolean;
	closed(): void;
	release(
		callbacks: AudioCallbacks,
		controls: TransferredVoiceControls,
	): Promise<void>;
}
