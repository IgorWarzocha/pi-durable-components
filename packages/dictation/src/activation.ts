import { isAbsolute } from "node:path";
import {
	type ComponentInstance,
	type ComponentRequest,
	defineCapability,
	isCapabilityObject,
	networkCapability,
	nodeExecutionCapability,
	stateCapability,
} from "@howaboua/pi-durable-components";
import type { DictationServiceOptions } from "./contracts.ts";
import { createDictationService } from "./index.ts";

/** Explicit native namespace grant; paths belong to that environment, not host discovery. */
export type DictationComponentOptions = DictationServiceOptions & {
	environmentId: string;
	modelSearchDirectories: readonly string[];
	language: string;
	numThreads: number;
	provider: string;
	fetchDownload: NonNullable<DictationServiceOptions["fetchDownload"]>;
};

export const dictationOptions = defineCapability<DictationComponentOptions>(
	"howaboua.dictation.options.v1",
	(value): value is DictationComponentOptions =>
		isCapabilityObject(value) &&
		typeof value["environmentId"] === "string" &&
		value["environmentId"].trim().length > 0 &&
		typeof value["modelDirectory"] === "string" &&
		isAbsolute(value["modelDirectory"]) &&
		Array.isArray(value["modelSearchDirectories"]) &&
		value["modelSearchDirectories"].every(
			(directory: unknown) =>
				typeof directory === "string" && isAbsolute(directory),
		) &&
		typeof value["language"] === "string" &&
		typeof value["numThreads"] === "number" &&
		Number.isSafeInteger(value["numThreads"]) &&
		value["numThreads"] > 0 &&
		typeof value["provider"] === "string" &&
		typeof value["fetchDownload"] === "function" &&
		typeof value["getSelectedModelId"] === "function",
);

export function createComponent(
	request: ComponentRequest,
): ComponentInstance<ReturnType<typeof createDictationService>> {
	const options = request.capabilities.has(dictationOptions.id)
		? request.capabilities.get(dictationOptions)
		: baselineOptions(request);
	const api = createDictationService(options);
	return {
		api,
		retention: "idle",
		beforeClose: () => api.dispose(),
	};
}

function baselineOptions(request: ComponentRequest): DictationComponentOptions {
	const native = request.capabilities.get(nodeExecutionCapability);
	const network = request.capabilities.get(networkCapability);
	const modelDirectory = request.capabilities
		.get(stateCapability)
		.directory("dictation");
	const modelId = request.configuration["modelId"] ?? null;
	if (
		modelId !== null &&
		modelId !== "tiny.en" &&
		modelId !== "base.en" &&
		modelId !== "small.en"
	)
		throw new Error("Unknown dictation model selection");
	const language = request.configuration["language"] ?? "";
	const provider = request.configuration["provider"] ?? "cpu";
	const numThreads = request.configuration["numThreads"] ?? 1;
	return dictationOptions.parse({
		environmentId: native.environmentId,
		modelDirectory,
		modelSearchDirectories: [],
		language,
		provider,
		numThreads,
		fetchDownload: (url: string, init: RequestInit) => network.fetch(url, init),
		getSelectedModelId: () => modelId,
	});
}
