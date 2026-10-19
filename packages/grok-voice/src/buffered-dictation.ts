import { setImmediate } from "node:timers/promises";
import {
	type BufferedDictationRequest,
	type DictationCredentials,
	dictationReadiness,
	prepareDictationAudio,
	withDictationDeadline,
} from "../../../internal/buffered-dictation.ts";
import type { RealtimeAudio } from "./audio.ts";
import { resolveBearer } from "./credentials.ts";
import { GrokDictationController } from "./dictation.ts";

export interface GrokDictationCredentials extends DictationCredentials {
	/** Must match the credential selected by Models. Defaults to the voice component's OAuth policy. */
	access?: "oauth" | "api_key";
}
export interface GrokBufferedDictationRequest
	extends BufferedDictationRequest,
		GrokDictationCredentials {}

/** Resolves xAI credentials through Models, without opening capture or a provider socket. */
export function checkGrokDictationReadiness(request: GrokDictationCredentials) {
	return dictationReadiness(request.signal, (signal) =>
		resolveBearer(request.models, request.access ?? "oauth", signal),
	);
}

/** Host-supplied audio uses the same STT controller as manual dictation, not a voice call. */
export async function transcribeGrokDictation(
	request: GrokBufferedDictationRequest,
): Promise<string> {
	const { pcm, sampleRate, language } = prepareDictationAudio(request);
	return withDictationDeadline(request.signal, async (signal) => {
		let closed = false;
		const audio: RealtimeAudio = {
			async start(callbacks) {
				for (let offset = 0; offset < pcm.length && !closed; offset += 32_000) {
					signal.throwIfAborted();
					callbacks.onAudio(pcm.subarray(offset, offset + 32_000));
					await setImmediate(undefined, { signal });
				}
			},
			play() {
				throw new Error("Dictation does not play audio");
			},
			clear() {},
			async drain() {},
			setMuted() {},
			async close() {
				closed = true;
			},
		};
		const controller = new GrokDictationController();
		try {
			await controller.start(
				request.models,
				{ access: request.access ?? "oauth", language },
				audio,
				signal,
				sampleRate,
			);
			signal.throwIfAborted();
			return await controller.finish();
		} finally {
			await controller.shutdown();
		}
	});
}
