import path from "node:path";
import {
	inferWhisperLanguage,
	type ResolvedWhisperModelFiles,
} from "./helpers.ts";

const whisperEncoderFilePattern = /^(.*)-encoder(\.int8)?\.onnx$/;
export function resolveWhisperModelFilesFromFilePaths(
	filePaths: string[],
): ResolvedWhisperModelFiles | null {
	const filesByDirectory = new Map<string, Set<string>>();

	for (const filePath of filePaths) {
		const directory = path.dirname(filePath);
		const fileName = path.basename(filePath);
		const entrySet = filesByDirectory.get(directory) ?? new Set<string>();
		entrySet.add(fileName);
		filesByDirectory.set(directory, entrySet);
	}

	const encoderCandidates = filePaths
		.map((filePath) => {
			const match = path.basename(filePath).match(whisperEncoderFilePattern);
			if (!match) {
				return null;
			}

			return {
				filePath,
				directory: path.dirname(filePath),
				modelId: match[1] ?? "",
				quantized: Boolean(match[2]),
			};
		})
		.filter((value): value is NonNullable<typeof value> => value !== null)
		.sort((left, right) => Number(right.quantized) - Number(left.quantized));

	for (const candidate of encoderCandidates) {
		const directoryFiles = filesByDirectory.get(candidate.directory);
		if (!directoryFiles) {
			continue;
		}

		const decoderFileName = [
			`${candidate.modelId}-decoder.int8.onnx`,
			`${candidate.modelId}-decoder.onnx`,
		].find((fileName) => directoryFiles.has(fileName));
		const tokensFileName = `${candidate.modelId}-tokens.txt`;

		if (!(decoderFileName && directoryFiles.has(tokensFileName))) {
			continue;
		}

		return {
			modelDirectory: candidate.directory,
			encoderPath: candidate.filePath,
			decoderPath: path.join(candidate.directory, decoderFileName),
			tokensPath: path.join(candidate.directory, tokensFileName),
			modelId: candidate.modelId,
			language: inferWhisperLanguage(candidate.modelId),
		};
	}

	return null;
}
