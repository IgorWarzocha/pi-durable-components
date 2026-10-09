import type { AudioCallbacks, RealtimeAudio } from "./audio.ts";

/** The departure task continues owning the real capture/playout process during transfer. */
export class SwitchableAudio implements RealtimeAudio {
	private readonly audio: RealtimeAudio;
	private callbacks: AudioCallbacks | undefined;
	constructor(audio: RealtimeAudio) {
		this.audio = audio;
	}
	async start(callbacks: AudioCallbacks): Promise<void> {
		this.callbacks = callbacks;
		await this.audio.start({
			onAudio: (pcm) => this.callbacks?.onAudio(pcm),
			onError: (error) => this.callbacks?.onError(error),
		});
	}
	transfer(callbacks: AudioCallbacks): void {
		this.callbacks = callbacks;
	}
	play(pcm: Buffer): void {
		this.audio.play(pcm);
	}
	clear(): void {
		this.audio.clear();
	}
	drain(): Promise<void> {
		return this.audio.drain();
	}
	setMuted(muted: boolean): void {
		this.audio.setMuted(muted);
	}
	async close(): Promise<void> {
		this.callbacks = undefined;
		await this.audio.close();
	}
}
