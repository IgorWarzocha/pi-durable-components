import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import {
	type BufferedDictationRequest,
	type DictationCredentials,
	dictationReadiness,
	prepareDictationAudio,
	withDictationDeadline,
} from "../../../internal/buffered-dictation.ts";
import { resolveCodexVoiceAuth } from "./voice/auth.ts";
import { CodexDictationTranscriber } from "./voice/dictation/transcriber.ts";

/** Checks canonical Codex OAuth through Models. No capture or transcription socket. */
export function checkGippityDictationReadiness({
	models,
	signal,
}: DictationCredentials) {
	return dictationReadiness(signal, (signal) =>
		resolveCodexVoiceAuth(models, randomUUID(), signal),
	);
}

/** Explicit server-side transcription only; never opens a microphone or submits a conversation. */
export async function transcribeGippityDictation(
	request: BufferedDictationRequest,
): Promise<string> {
	const { pcm, sampleRate, language } = prepareDictationAudio(request);
	return withDictationDeadline(request.signal, async (signal) => {
		const auth = await resolveCodexVoiceAuth(
			request.models,
			randomUUID(),
			signal,
		);
		signal.throwIfAborted();
		const transcriber = new CodexDictationTranscriber({
			onError() {},
			onStatus() {},
		});
		// The finally block joins teardown and reports any cleanup failure.
		const cancel = () => {
			void transcriber.close().catch(() => {});
		};
		signal.addEventListener("abort", cancel, { once: true });
		try {
			await transcriber.start(auth, language);
			signal.throwIfAborted();
			const input = sampleRate === 24000 ? pcm : upsamplePcm16(pcm);
			for (let offset = 0; offset < input.length; offset += 24_000) {
				signal.throwIfAborted();
				transcriber.append(input.subarray(offset, offset + 24_000));
				await setImmediate(undefined, { signal });
			}
			return (await transcriber.finish()) ?? "";
		} finally {
			signal.removeEventListener("abort", cancel);
			await transcriber.close();
		}
	});
}

/** 16 kHz to the transcriber's 24 kHz format. Upsampling needs no low-pass decimation. */
function upsamplePcm16(input: Buffer): Buffer {
	const samples = input.length / 2;
	const output = Buffer.allocUnsafe(Math.floor(samples * 1.5) * 2);
	for (let i = 0; i < output.length / 2; i++) {
		const position = (i * 2) / 3;
		const left = Math.floor(position);
		const a = input.readInt16LE(left * 2);
		const b = input.readInt16LE(Math.min(left + 1, samples - 1) * 2);
		output.writeInt16LE(Math.round(a + (b - a) * (position - left)), i * 2);
	}
	return output;
}
