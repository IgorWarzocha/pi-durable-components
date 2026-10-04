import {
	defineExtension,
	defineTool,
	section,
} from "@earendil-works/pi-durable";
import { jsonValue } from "../../../internal/codex/json.ts";
import {
	WEB_SEARCH_MAX_RESPONSE_BYTES,
	WEB_SEARCH_PARAMETERS,
	WEB_SEARCH_TOOL_NAME,
} from "./contract.ts";
import { executeCodexWebSearch, type WebSearchToolOptions } from "./execute.ts";

export { normalizeCodexToolRouteConfig } from "../../../internal/codex/config.ts";
export type {
	CodexRuntimeOptions,
	CodexToolProvider,
} from "../../../internal/codex/types.ts";
export { WEB_SEARCH_PARAMETERS } from "./contract.ts";
export type { WebSearchToolOptions } from "./execute.ts";

export function createWebSearchTool(
	options: WebSearchToolOptions,
	name = WEB_SEARCH_TOOL_NAME,
) {
	return defineTool({
		name,
		description: "Search/open web",
		parameters: WEB_SEARCH_PARAMETERS,
		replay: "unsafe",
		outputLimits: {
			maxBytes: WEB_SEARCH_MAX_RESPONSE_BYTES,
			maxLines: Number.MAX_SAFE_INTEGER,
		},
		async execute(params, api, context) {
			const output = await executeCodexWebSearch(params, api, context, options);
			return {
				content: [{ type: "text", text: output.text }],
				details: { webRun: jsonValue(output.details) },
			};
		},
	});
}

export function createWebSearchExtension(options: WebSearchToolOptions) {
	return defineExtension({
		name: "web",
		tools: [
			createWebSearchTool({ allowCodexProviderFallback: true, ...options }),
		],
		sections: [
			section(
				"web_refs",
				() =>
					"web_run: Calls use returned turn refs; final answers use Markdown result URLs, never refs or citation markers.",
			),
		],
	});
}
