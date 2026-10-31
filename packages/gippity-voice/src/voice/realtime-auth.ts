import type { Models, TSchema } from "@earendil-works/pi-ai";
import { normalizeVoiceApiProvider } from "../config.ts";
import type { CodexVoiceAuth } from "./auth.ts";

export interface PublicRealtimeAccess {
	tools: {
		definitions: Array<{
			type: "function";
			name: string;
			description: string;
			parameters: TSchema;
		}>;
		execute(
			name: string,
			args: unknown,
			context: { signal: AbortSignal; callId: string },
		): Promise<unknown>;
	};
}

/** Exact provider selection. OAuth is never substituted for public API access. */
export async function resolvePublicRealtimeAuth(
	models: Models,
	name: string,
	signal: AbortSignal,
	access: PublicRealtimeAccess,
): Promise<CodexVoiceAuth> {
	if (!normalizeVoiceApiProvider(name))
		throw new Error(
			"Enter a nonempty API provider name in voice settings (at most 512 bytes, no surrounding whitespace or control characters).",
		);
	const provider = models.getProvider(name);
	const authError =
		"Realtime requires an API key for the exact API provider name in voice settings. Configure that provider, or change the name. ChatGPT and OAuth logins cannot be used.";
	let auth;
	try {
		if ((await models.checkAuth(name, { signal }))?.type !== "api_key")
			throw new Error(authError);
		auth = await models.getAuth(name, { signal });
	} catch (error) {
		signal.throwIfAborted();
		throw new Error(authError, { cause: error });
	}
	signal.throwIfAborted();
	if (
		!provider ||
		!auth?.auth.apiKey?.trim() ||
		auth.source?.toLowerCase() === "oauth"
	)
		throw new Error(authError);
	const route = auth.auth.baseUrl ?? provider.baseUrl;
	const routeError =
		"Realtime requires a valid HTTP or HTTPS base URL for the selected API provider without URL credentials, query or fragment.";
	if (typeof route !== "string") throw new Error(routeError);
	let url: URL;
	try {
		url = new URL(route);
	} catch {
		throw new Error(routeError);
	}
	if (
		!/^https?:\/\//i.test(route) ||
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		/[\s\\?#]/u.test(route)
	)
		throw new Error(routeError);
	const headers = new Headers();
	try {
		for (const entries of [provider.headers, auth.auth.headers]) {
			const seen = new Map<string, string | null>();
			for (const [name, value] of Object.entries(entries ?? {})) {
				if (value !== null && typeof value !== "string")
					throw new Error("Invalid header");
				const normal = value?.trim() ?? null;
				const lower = name.toLowerCase();
				if (seen.has(lower) && seen.get(lower) !== normal)
					throw new Error("Conflicting headers");
				seen.set(lower, normal);
				if (value === null) headers.delete(name);
				else headers.set(name, value);
			}
		}
		const authorization = headers.get("authorization");
		if (
			authorization !== null &&
			authorization !== `Bearer ${auth.auth.apiKey}`
		)
			throw new Error("Conflicting authorization");
		headers.set("authorization", `Bearer ${auth.auth.apiKey}`);
	} catch {
		throw new Error(
			"Realtime could not use the selected provider's API headers. Configure valid headers matching its API key, then start again.",
		);
	}
	return {
		headers,
		baseUrl: url.href.replace(/\/+$/, ""),
		officialCodex: false,
		realtime: access,
		...(auth.env ? { env: auth.env } : {}),
	};
}
