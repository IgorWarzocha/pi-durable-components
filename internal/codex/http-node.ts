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
			const response = await fetch(url, {
				...init,
				headers: Object.fromEntries(init.headers.entries()),
				...(dispatcher ? { dispatcher } : {}),
			});
			return response;
		},
		async close() {
			await Promise.all(
				[...dispatchers.values()].map((agent) => agent.close()),
			);
		},
	};
}
