import type { Context } from "@earendil-works/chord";
import type {
	Api,
	Model,
	Models,
	ProviderHeaders,
} from "@earendil-works/pi-ai";
import type { CodexToolRouteConfig } from "./config.ts";

export const CODEX_TOOL_PROVIDER_UNSUPPORTED_MESSAGE =
	"Codex-backed tool requires an OpenAI Codex-compatible Responses provider";
export const CODEX_TOOL_ORIGINATOR = "codex_cli_rs";
export const OPENAI_CODEX_PROVIDER = "openai-codex";
export const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
export type CodexModel = Model<Api>;
export interface CodexToolProvider {
	route: "openai-codex" | "configured-responses";
	baseUrl: string;
	responsesUrl: string;
	searchUrl: string;
	model: string | undefined;
	token: string;
	accountId: string;
	headers?: ProviderHeaders;
}
export interface CodexRuntimeOptions {
	models: Models;
	routes?: CodexToolRouteConfig;
	/** Explicit opt-in for an ordinary Responses backend with Codex tool endpoints. */
	allowConfiguredProvider?: (model: CodexModel | undefined) => boolean;
	allowCodexProviderFallback?: boolean;
	resolveProvider?: (
		model: CodexModel | undefined,
		context: Context,
	) => Promise<CodexToolProvider | undefined>;
}
