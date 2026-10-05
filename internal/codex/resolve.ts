import type { Context } from "@earendil-works/chord";
import type { ProviderHeaders } from "@earendil-works/pi-ai";
import { isCodexToolRoute } from "./config.ts";
import {
	CODEX_TOOL_PROVIDER_UNSUPPORTED_MESSAGE,
	type CodexModel,
	type CodexRuntimeOptions,
	type CodexToolProvider,
	OPENAI_CODEX_PROVIDER,
} from "./types.ts";
import {
	resolveCodexApiProviderBaseUrl,
	resolveCodexResponsesUrl,
	resolveCodexSearchUrl,
} from "./urls.ts";

const PREFERRED_MODELS = [
	"gpt-5.6-luna",
	"gpt-5.6-terra",
	"gpt-5.6-sol",
	"gpt-5.5",
	"gpt-5.4-mini",
];

function codexTransport(
	model: CodexModel | undefined,
	options: CodexRuntimeOptions,
): boolean {
	return Boolean(
		model &&
			(model.provider.trim().toLowerCase() === OPENAI_CODEX_PROVIDER ||
				model.api.trim().toLowerCase() === "openai-codex-responses" ||
				(options.routes && isCodexToolRoute(options.routes, model))),
	);
}
export function supportsExecutableCodexTool(
	model: CodexModel | undefined,
	options: CodexRuntimeOptions,
	images = false,
): boolean {
	return Boolean(
		(model?.api.includes("responses") &&
			codexTransport(model, options) &&
			(!images || model.input.includes("image"))) ||
			options.allowConfiguredProvider?.(model) ||
			options.allowCodexProviderFallback === true,
	);
}

async function resolveAuthModel(
	current: CodexModel | undefined,
	options: CodexRuntimeOptions,
	context: Context,
): Promise<CodexModel> {
	if (
		current &&
		((options.routes && isCodexToolRoute(options.routes, current)) ||
			(current.api.includes("responses") &&
				(codexTransport(current, options) ||
					options.allowConfiguredProvider?.(current))))
	)
		return current;
	const usable = (model: CodexModel | undefined): model is CodexModel =>
		Boolean(
			model &&
				model.provider.trim().toLowerCase() === OPENAI_CODEX_PROVIDER &&
				model.api.includes("responses"),
		);
	const direct = current
		? options.models.getModel(OPENAI_CODEX_PROVIDER, current.id)
		: undefined;
	if (usable(direct)) return direct;
	const preferred = PREFERRED_MODELS.map((id) =>
		options.models.getModel(OPENAI_CODEX_PROVIDER, id),
	).find(usable);
	if (preferred) return preferred;
	const available = (
		await options.models.getAvailable(
			undefined,
			context.abortSignal ? { signal: context.abortSignal } : {},
		)
	).find(usable);
	const fallback = available ?? options.models.getModels().find(usable);
	if (fallback) return fallback;
	throw new Error(CODEX_TOOL_PROVIDER_UNSUPPORTED_MESSAGE);
}

function headerValue(
	headers: ProviderHeaders | undefined,
	name: string,
): string | undefined {
	const entry = Object.entries(headers ?? {}).find(
		([key]) => key.toLowerCase() === name.toLowerCase(),
	);
	return typeof entry?.[1] === "string" ? entry[1] : undefined;
}

function extractAccountId(token: string): string {
	try {
		const payload = token.split(".")[1];
		if (!payload) throw new Error("Invalid token");
		const claims: unknown = JSON.parse(
			new TextDecoder().decode(
				Uint8Array.from(
					atob(payload.replace(/-/g, "+").replace(/_/g, "/")),
					(character) => character.charCodeAt(0),
				),
			),
		);
		const auth =
			claims &&
			typeof claims === "object" &&
			"https://api.openai.com/auth" in claims
				? claims["https://api.openai.com/auth"]
				: undefined;
		const id =
			auth && typeof auth === "object" && "chatgpt_account_id" in auth
				? auth.chatgpt_account_id
				: undefined;
		if (typeof id !== "string" || !id) throw new Error("No account ID");
		return id;
	} catch {
		throw new Error("Failed to extract accountId from token");
	}
}

export async function resolveCodexToolProvider(
	current: CodexModel | undefined,
	options: CodexRuntimeOptions,
	context: Context,
): Promise<CodexToolProvider> {
	// Explicit route configuration outranks the hosted resolver, as in the pinned implementation.
	if (!(options.routes && isCodexToolRoute(options.routes, current))) {
		const hosted = await options.resolveProvider?.(current, context);
		if (hosted) return hosted;
	}
	const model = await resolveAuthModel(current, options, context);
	const resolution = await options.models.getAuth(
		model,
		context.abortSignal ? { signal: context.abortSignal } : {},
	);
	if (!resolution) throw new Error(CODEX_TOOL_PROVIDER_UNSUPPORTED_MESSAGE);
	const auth = resolution.auth;
	const codex = codexTransport(model, options);
	const authorization = headerValue(auth.headers, "authorization")
		?.match(/^Bearer\s+(.+)$/i)?.[1]
		?.trim();
	const token = codex
		? (auth.apiKey ?? authorization)
		: (authorization ?? auth.apiKey);
	if (!token) throw new Error(CODEX_TOOL_PROVIDER_UNSUPPORTED_MESSAGE);
	const resolvedBase = auth.baseUrl ?? model.baseUrl;
	const baseUrl = codex
		? resolveCodexApiProviderBaseUrl(resolvedBase)
		: resolvedBase?.trim().replace(/\/+$/, "");
	if (!baseUrl)
		throw new Error("Configured Responses provider is missing a base URL");
	const responsesUrl = codex
		? resolveCodexResponsesUrl(baseUrl)
		: baseUrl.endsWith("/responses")
			? baseUrl
			: baseUrl + "/responses";
	return {
		route: codex ? "openai-codex" : "configured-responses",
		baseUrl,
		responsesUrl,
		searchUrl: resolveCodexSearchUrl(responsesUrl),
		model: model.id,
		token,
		accountId:
			headerValue(auth.headers, "chatgpt-account-id") ??
			(codex ? extractAccountId(token) : ""),
		...(auth.headers ? { headers: auth.headers } : {}),
	};
}
