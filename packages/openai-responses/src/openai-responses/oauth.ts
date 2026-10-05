// Direct refresh adapted from pi-ai 1.0.2 auth/oauth/openai-chatgpt.js (MIT).
import type { OAuthAuth } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

/** Keep refresh fetch-native. Stock interactive login remains a Node host operation. */
export const directOpenAIOAuth: OAuthAuth = {
	name: "OpenAI (ChatGPT subscription)",
	isSubscription: true,
	loginLabel: "Sign in with ChatGPT",
	async login(interaction, options) {
		const oauth = openaiProvider().auth.oauth;
		if (!oauth) throw new Error("Stock OpenAI OAuth is unavailable");
		return oauth.login(interaction, options);
	},
	async toAuth(credential) {
		return { apiKey: credential.access };
	},
	async refresh(credential, signal) {
		const clientId = credential["clientId"];
		if (typeof clientId !== "string" || !clientId.trim())
			throw new Error(
				"Stored OpenAI OAuth credential does not contain an issued client ID; reconnect ChatGPT",
			);
		const response = await fetch(
			"https://auth.openai.com/api/accounts/oauth/token",
			{
				method: "POST",
				headers: {
					accept: "application/json",
					"content-type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams({
					grant_type: "refresh_token",
					client_id: clientId,
					refresh_token: credential.refresh,
					resource: "https://api.openai.com/v1",
				}),
				signal,
			},
		);
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`OpenAI OAuth token request failed (${response.status})`);
		}
		const token: unknown = await response.json();
		if (!token || typeof token !== "object" || Array.isArray(token))
			throw new Error("OpenAI OAuth token response must be an object");
		const field = (name: string): string => {
			const value = (token as Record<string, unknown>)[name];
			if (typeof value !== "string" || !value.trim())
				throw new Error(`OpenAI OAuth token response has invalid ${name}`);
			return value;
		};
		const access = field("access_token");
		const refresh = field("refresh_token");
		const scopes = field("scope").trim().split(/\s+/);
		const expiresIn = (token as Record<string, unknown>)["expires_in"];
		if (
			typeof expiresIn !== "number" ||
			!Number.isFinite(expiresIn) ||
			expiresIn <= 0
		)
			throw new Error("OpenAI OAuth token response has invalid expires_in");
		if (!scopes.includes("chatgpt.tokens.use.direct"))
			throw new Error(
				"OpenAI OAuth grant did not include chatgpt.tokens.use.direct",
			);
		return {
			type: "oauth",
			access,
			refresh,
			expires: Date.now() + expiresIn * 1000 - 180_000,
			clientId,
			scopes,
		};
	},
};
