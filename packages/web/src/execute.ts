import type { Context } from "@earendil-works/chord";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { resolveCodexToolModel } from "../../../internal/codex/config.ts";
import {
	callingModel,
	providerSessionId,
} from "../../../internal/codex/durable.ts";
import { codexToolProviderHeaders } from "../../../internal/codex/headers.ts";
import { fetchCodexTool } from "../../../internal/codex/http.ts";
import {
	resolveCodexToolProvider,
	supportsExecutableCodexTool,
} from "../../../internal/codex/resolve.ts";
import type { CodexRuntimeOptions } from "../../../internal/codex/types.ts";
import {
	DEFAULT_WEB_SEARCH_MODEL,
	WEB_SEARCH_MAX_RESPONSE_BYTES,
	WEB_SEARCH_UNSUPPORTED_MESSAGE,
} from "./contract.ts";
import { buildWebSearchRequest, normalizeSearchResponse } from "./request.ts";

export interface WebSearchToolOptions extends CodexRuntimeOptions {
	model?: string | (() => string | undefined);
	/** Native Worker fetch. Defaults to Node's proxy and permitted-cookie transport. */
	runtime?: "node" | "workerd";
}

export async function executeCodexWebSearch(
	params: Record<string, unknown>,
	api: ToolExecutionApi,
	context: Context,
	options: WebSearchToolOptions,
) {
	const current = await callingModel(api, options, context);
	if (!supportsExecutableCodexTool(current, options))
		throw new Error(WEB_SEARCH_UNSUPPORTED_MESSAGE);
	const provider = await resolveCodexToolProvider(current, options, context);
	const configured =
		(typeof options.model === "function" ? options.model() : options.model) ??
		(options.runtime === "workerd"
			? undefined
			: process.env["PI_CODEX_MODEL"]?.trim() || undefined);
	const body = buildWebSearchRequest(params, {
		id: await providerSessionId(api, context),
		model:
			provider.route === "configured-responses"
				? (provider.model ?? DEFAULT_WEB_SEARCH_MODEL)
				: resolveCodexToolModel(
						options.routes ?? { providers: {} },
						current,
						configured ?? DEFAULT_WEB_SEARCH_MODEL,
					),
	});
	const response = await fetchCodexTool(provider.searchUrl, {
		method: "POST",
		headers: codexToolProviderHeaders(provider, options.runtime),
		body: JSON.stringify(body),
		...(context.abortSignal ? { signal: context.abortSignal } : {}),
		maxResponseBytes: WEB_SEARCH_MAX_RESPONSE_BYTES,
		...(options.runtime ? { runtime: options.runtime } : {}),
	});
	// The backend body becomes Durable state and model-visible diagnostics.
	const responseText = provider.token
		? response.text.replaceAll(provider.token, "[redacted]")
		: response.text;
	const challenge =
		response.headers.get("cf-mitigated")?.toLowerCase() === "challenge" ||
		(response.headers.get("server")?.toLowerCase() === "cloudflare" &&
			responseText.trimStart().startsWith("<html"));
	if (response.status < 200 || response.status >= 300) {
		if (
			response.status === 403 &&
			(challenge || responseText.toLowerCase().includes("cloudflare"))
		)
			throw new Error(
				"web_run search failed for " +
					provider.searchUrl +
					": HTTP 403 Cloudflare challenge",
			);
		if (response.status === 404 && responseText.includes('"Not Found"'))
			throw new Error(
				"web_run search failed for " +
					provider.searchUrl +
					": HTTP 404 Not Found (Codex endpoint unavailable for this account/backend)",
			);
		throw new Error(
			"web_run search failed for " +
				provider.searchUrl +
				": HTTP " +
				response.status +
				" " +
				responseText,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(responseText);
	} catch {
		throw new Error("failed to decode web_run search response");
	}
	const details = normalizeSearchResponse(parsed);
	const text =
		typeof details.output_text === "string" && details.output_text.trim()
			? details.output_text
			: JSON.stringify(details, null, 2);
	return { text, details };
}
