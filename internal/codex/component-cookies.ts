import { ChatGptCloudflareCookieStore } from "./cloudflare-cookies.ts";
import type { CodexToolProvider } from "./types.ts";

const MAX_SESSIONS = 64;

/** Marketplace-owned ephemeral cookies. Legacy direct factories retain their existing policy. */
export function createComponentCookieStores() {
	const sessions = new Map<string, ChatGptCloudflareCookieStore>();
	let closed = false;
	return {
		forProvider(provider: CodexToolProvider): ChatGptCloudflareCookieStore {
			if (closed) throw new Error("Component cookie stores are closed");
			// Credentials stay private and ephemeral. Empty account IDs on custom routes
			// must not merge distinct credentials; rotation starts a new cookie session.
			const key = JSON.stringify([
				provider.route,
				provider.accountId,
				provider.token,
				...[provider.baseUrl, provider.responsesUrl, provider.searchUrl].map(
					(url) => new URL(url).origin,
				),
			]);
			const store = sessions.get(key) ?? new ChatGptCloudflareCookieStore();
			sessions.delete(key);
			sessions.set(key, store);
			// Eviction may discard affinity, never transfer it to another session.
			while (sessions.size > MAX_SESSIONS) {
				const oldest = sessions.keys().next().value;
				if (oldest !== undefined) sessions.delete(oldest);
			}
			return store;
		},
		close() {
			closed = true;
			sessions.clear();
		},
	};
}
