const englishWhisperModelPattern = /(^|[._-])en($|[._-])/;
const languageSubtagSeparatorPattern = /[-_]/;

export type ResolvedWhisperModelFiles = {
	modelDirectory: string;
	encoderPath: string;
	decoderPath: string;
	tokensPath: string;
	modelId: string;
	language: string | null;
};

export function inferWhisperLanguage(modelId: string) {
	return englishWhisperModelPattern.test(modelId) ? "en" : null;
}

export function normalizeWhisperLanguage(language: string | null | undefined) {
	if (!language) {
		return null;
	}

	const normalized = language.trim().toLowerCase();
	if (!normalized) {
		return null;
	}

	const primarySubtag = normalized
		.split(languageSubtagSeparatorPattern)[0]
		?.trim();
	return primarySubtag || null;
}

export function decodePcm16MonoBytes(bytes: Uint8Array) {
	const sampleCount = Math.floor(bytes.byteLength / 2);
	const samples = new Float32Array(sampleCount);

	for (let index = 0; index < sampleCount; index += 1) {
		const lowByte = bytes[index * 2] ?? 0;
		const highByte = bytes[index * 2 + 1] ?? 0;
		let sample = (highByte << 8) | lowByte;

		if (sample & 0x8000) {
			sample -= 0x1_0000;
		}

		samples[index] = sample === -32_768 ? -1 : sample / 32_767;
	}

	return samples;
}

export const DEFAULT_DICTATION_MAX_DURATION_SECONDS = 180;
export const DICTATION_MAX_DURATION_OPTIONS = [60, 180, 300, 600] as const;

export function normalizeDictationMaxDurationSeconds(
	value: number | null | undefined,
) {
	return (
		DICTATION_MAX_DURATION_OPTIONS.find((option) => option === value) ?? null
	);
}
