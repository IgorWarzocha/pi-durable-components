import {
	ChatGptCloudflareCookieStore,
	isChatGptCookieUrl,
} from "./cloudflare-cookies.ts";

const cloudflareCookies = new ChatGptCloudflareCookieStore();

// External native dependencies must remain lazy even in the bundled public entry.
// Workerd uses native fetch and never initialises this adapter.
export async function createNodeCodexTransport() {
	const [{ fetch, ProxyAgent }, { getProxyForUrl }] = await Promise.all([
		import("undici"),
		import("proxy-from-env"),
	]);
	const dispatchers = new Map<string, InstanceType<typeof ProxyAgent>>();
	return {
		async fetch(
			url: URL,
			init: {
				method?: string;
				headers: Headers;
				body?: string;
				signal?: AbortSignal;
				redirect: "manual";
			},
		) {
			const proxy = getProxyForUrl(url.href);
			let dispatcher = proxy ? dispatchers.get(proxy) : undefined;
			if (proxy && !dispatcher) {
				dispatcher = new ProxyAgent(proxy);
				dispatchers.set(proxy, dispatcher);
			}
			const headers = new Headers(init.headers);
			const cookieHeader = cloudflareCookies.requestHeader(url);
			if (cookieHeader) headers.set("cookie", cookieHeader);
			const response = await fetch(url, {
				...init,
				headers: Object.fromEntries(headers.entries()),
				...(dispatcher ? { dispatcher } : {}),
			});
			if (isChatGptCookieUrl(url))
				cloudflareCookies.storeResponse(url, response.headers.getSetCookie());
			return response;
		},
		async close() {
			await Promise.all(
				[...dispatchers.values()].map((agent) => agent.close()),
			);
		},
	};
}
