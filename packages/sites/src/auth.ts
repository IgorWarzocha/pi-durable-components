import type { Context } from "@earendil-works/chord";
import type { AuthResult, Models } from "@earendil-works/pi-ai";

const authMessage =
	"Sites requires a canonical ChatGPT Codex OAuth login configured by the host";

function canonicalBase(value: string | undefined) {
	if (!value) return false;
	try {
		const url = new URL(value);
		return (
			url.origin === "https://chatgpt.com" &&
			!url.username &&
			!url.password &&
			!url.search &&
			!url.hash &&
			["/backend-api", "/backend-api/codex"].includes(
				url.pathname.replace(/\/+$/, ""),
			)
		);
	} catch {
		return false;
	}
}

/** OAuth resolves through Models, not ambient Pi auth files or model-selected URLs. */
export async function getSitesAuth(
	models: Models,
	providerId: string,
	context: Context,
) {
	context.abortSignal?.throwIfAborted();
	const provider = models.getProvider(providerId);
	const options = context.abortSignal ? { signal: context.abortSignal } : {};
	if (!provider?.auth.oauth || !canonicalBase(provider.baseUrl))
		throw new Error(authMessage);
	let resolved: AuthResult | undefined;
	try {
		if ((await models.checkAuth(providerId, options))?.type !== "oauth")
			throw new Error(authMessage);
		resolved = await models.getAuth(providerId, options);
	} catch {
		// Credential resolution errors can contain provider-specific secret diagnostics.
		throw new Error(authMessage);
	}
	if (
		!resolved ||
		(resolved.auth.baseUrl !== undefined &&
			!canonicalBase(resolved.auth.baseUrl))
	)
		throw new Error(authMessage);
	const authorization = Object.entries(resolved.auth.headers ?? {}).find(
		([key]) => key.toLowerCase() === "authorization",
	)?.[1];
	const token =
		resolved.auth.apiKey ??
		(typeof authorization === "string"
			? authorization.match(/^Bearer\s+(.+)$/i)?.[1]
			: undefined);
	if (!token) throw new Error(authMessage);
	try {
		const encoded = token.split(".")[1];
		if (!encoded) throw new Error(authMessage);
		const claims: unknown = JSON.parse(
			Buffer.from(encoded, "base64url").toString("utf8"),
		);
		if (
			!claims ||
			typeof claims !== "object" ||
			!("https://api.openai.com/auth" in claims)
		)
			throw new Error(authMessage);
		const identity = claims["https://api.openai.com/auth"];
		if (
			!identity ||
			typeof identity !== "object" ||
			!("chatgpt_account_id" in identity) ||
			typeof identity.chatgpt_account_id !== "string" ||
			!identity.chatgpt_account_id
		)
			throw new Error(authMessage);
		return { token, accountId: identity.chatgpt_account_id };
	} catch {
		throw new Error(authMessage);
	}
}
