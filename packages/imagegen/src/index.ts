import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { jsonValue } from "../../../internal/codex/json.ts";
import {
	IMAGE_GENERATION_PARAMETERS,
	IMAGE_GENERATION_TOOL_NAME,
} from "./contract.ts";
import {
	executeCodexImageGeneration,
	type ImageGenerationToolOptions,
} from "./execute.ts";
import { formatImagegenOutput } from "./output.ts";

export { normalizeCodexToolRouteConfig } from "../../../internal/codex/config.ts";
export type {
	CodexRuntimeOptions,
	CodexToolProvider,
} from "../../../internal/codex/types.ts";
export { IMAGE_GENERATION_PARAMETERS } from "./contract.ts";
export type { ImageGenerationToolOptions } from "./execute.ts";
export type { ImagegenOutput } from "./output.ts";

export function createImageGenerationTool(options: ImageGenerationToolOptions) {
	return defineTool({
		name: IMAGE_GENERATION_TOOL_NAME,
		description: "Generate/edit images; omit selectors to generate",
		parameters: IMAGE_GENERATION_PARAMETERS,
		replay: "unsafe",
		executionMode: "sequential",
		async execute(args, api, context) {
			const result = await executeCodexImageGeneration(
				args,
				api,
				context,
				options,
			);
			return {
				content: [
					{ type: "text", text: formatImagegenOutput(result.output) },
					...result.content,
				],
				details: jsonValue(result.output),
			};
		},
	});
}

export function createImageGenerationExtension(
	options: ImageGenerationToolOptions,
) {
	return defineExtension({
		name: "imagegen",
		tools: [
			createImageGenerationTool({
				allowCodexProviderFallback: true,
				...options,
			}),
		],
	});
}
