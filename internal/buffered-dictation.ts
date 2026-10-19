import type { Models } from "@earendil-works/pi-ai";

export interface DictationCredentials {
	models: Models;
	signal: AbortSignal;
}
export type DictationReadiness =
	| { ready: true }
	| { ready: false; reason: string };
export interface BufferedDictationRequest extends DictationCredentials {
	/** Mono signed PCM16 little-endian, without a WAV header. 100 ms to 600 seconds. */
	audio: Uint8Array;
	sampleRate: 16000 | 24000;
	/** Omitted, empty or "auto" selects provider language detection. */
	language?: string;
}

/** Validate and own the caller's bytes before authentication or provider I/O. */
export function prepareDictationAudio(request: BufferedDictationRequest) {
	request.signal.throwIfAborted();
	const { audio, sampleRate } = request;
	if (sampleRate !== 16000 && sampleRate !== 24000)
		throw new Error("Dictation sampleRate must be 16000 or 24000 Hz");
	if (
		!(audio instanceof Uint8Array) ||
		audio.byteLength % 2 !== 0 ||
		audio.byteLength < sampleRate * 2 * 0.1 ||
		audio.byteLength > sampleRate * 2 * 600
	)
		throw new Error(
			"Dictation requires 100 ms to 600 seconds of mono PCM16 LE",
		);
	if (
		request.language !== undefined &&
		(typeof request.language !== "string" ||
			Buffer.byteLength(request.language) > 64 ||
			/[\u0000-\u001f\u007f]/u.test(request.language))
	)
		throw new Error("Dictation language must be a short language code or auto");
	const language = request.language?.trim() ?? "";
	return {
		pcm: Buffer.from(audio),
		sampleRate,
		language: language.toLowerCase() === "auto" ? "" : language,
	};
}

/** One bounded operation, with no retry or fallback to another billed provider. */
export async function withDictationDeadline<T>(
	signal: AbortSignal,
	work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	signal.throwIfAborted();
	const deadline = new AbortController();
	const timer = setTimeout(
		() => deadline.abort(new Error("Dictation request exceeded 60 seconds")),
		60_000,
	);
	const combined = AbortSignal.any([signal, deadline.signal]);
	try {
		const value = await work(combined);
		combined.throwIfAborted();
		return value;
	} catch (error) {
		combined.throwIfAborted();
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

export async function dictationReadiness(
	signal: AbortSignal,
	resolve: (signal: AbortSignal) => Promise<unknown>,
): Promise<DictationReadiness> {
	try {
		await withDictationDeadline(signal, resolve);
		return { ready: true };
	} catch (error) {
		signal.throwIfAborted();
		return {
			ready: false,
			reason:
				error instanceof Error
					? error.message
					: "Dictation credentials unavailable",
		};
	}
}
