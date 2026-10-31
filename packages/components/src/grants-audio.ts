import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { defineCapability, isCapabilityObject } from "./capabilities.ts";

/** One atomic, rejecting owner shared by every audio product in an application. */
export interface AudioLease {
	acquire(
		request: { owner: string; mode: "voice" | "dictation" },
		signal: AbortSignal,
	): Promise<{ release(): Promise<void> }>;
}

export const audioLeaseCapability = defineCapability<AudioLease>(
	"howaboua.audio.lease.v1",
	(value): value is AudioLease =>
		isCapabilityObject(value) && typeof value["acquire"] === "function",
);

/** Credential-free native capture/playout with the realtime-v3 helper wire protocol. */
export interface NativeWebRtcAudioGrant {
	readonly environmentId: string;
	launch(): ChildProcessWithoutNullStreams;
}

export const nativeWebRtcAudioCapability =
	defineCapability<NativeWebRtcAudioGrant>(
		"durable.audio.webrtc-native.v1",
		(value): value is NativeWebRtcAudioGrant =>
			isCapabilityObject(value) &&
			typeof value["environmentId"] === "string" &&
			value["environmentId"].length > 0 &&
			typeof value["launch"] === "function",
	);

/** Full-duplex 24kHz mono signed i16 LE, with explicit playout settlement. */
export interface Pcm24Audio {
	start(callbacks: {
		onAudio(pcm: Buffer): void;
		onError(error: Error): void;
	}): Promise<void>;
	play(pcm: Buffer): void;
	clear(): void;
	drain(): Promise<void>;
	setMuted(muted: boolean): void;
	close(): Promise<void>;
	stopCall?(): void;
	resumeCall?(): void;
	disconnect?(): void;
}

export interface Pcm24AudioGrant {
	readonly environmentId: string;
	/** Creates an idle endpoint; must not open the device before start(). */
	create(devices: { microphone: string; speaker: string }): Pcm24Audio;
}

export const pcm24AudioCapability = defineCapability<Pcm24AudioGrant>(
	"durable.audio.pcm24.v1",
	(value): value is Pcm24AudioGrant =>
		isCapabilityObject(value) &&
		typeof value["environmentId"] === "string" &&
		value["environmentId"].length > 0 &&
		typeof value["create"] === "function",
);
