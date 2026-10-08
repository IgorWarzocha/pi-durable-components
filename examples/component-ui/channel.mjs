// HTTP framing is host-owned. Capability values remain opaque JSON.
export function stateSource(value) {
	let snapshot = { sequence: 0, value };
	const listeners = new Set();
	return {
		getSnapshot: () => snapshot,
		publish(value) {
			snapshot = { sequence: snapshot.sequence + 1, value };
			for (const listener of listeners) listener(snapshot);
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

export async function dispatch(channels, request, response, signal) {
	const url = new URL(request.url, "http://localhost");
	const channel = channels.get(url.searchParams.get("id"));
	if (!channel) throw new Error("Unknown channel");
	if (request.method === "GET" && url.pathname === "/stream") {
		if (!channel.openStream) throw new Error("Streams not granted");
		response.writeHead(200, { "Content-Type": "application/x-ndjson" });
		const unsubscribe = channel.openStream(
			url.searchParams.get("name"),
			(value) => {
				if (!response.write(`${JSON.stringify(value)}\n`))
					response.destroy(new Error("Slow subscriber"));
			},
		);
		response.flushHeaders();
		signal.addEventListener("abort", unsubscribe, { once: true });
		return;
	}
	if (request.method === "GET" && url.pathname === "/updates") {
		response.writeHead(200, { "Content-Type": "application/x-ndjson" });
		// Subscribe and capture the initial frame synchronously, with no update gap.
		const send = (snapshot) => {
			if (!response.write(`${JSON.stringify(snapshot)}\n`))
				response.destroy(new Error("Slow subscriber"));
		};
		const unsubscribe = channel.subscribe(send);
		signal.addEventListener("abort", unsubscribe, { once: true });
		try {
			send(channel.getSnapshot());
		} catch (error) {
			unsubscribe();
			throw error;
		}
		return;
	}
	if (request.method !== "POST" || url.pathname !== "/call")
		throw new Error("Unknown operation");
	const chunks = [];
	let bytes = 0;
	for await (const chunk of request) {
		bytes += chunk.length;
		if (bytes > 65536) throw new Error("Request too large");
		chunks.push(chunk);
	}
	const { action, input } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	if (typeof action !== "string") throw new Error("Action required");
	const result = await channel.call(action, input, { signal });
	response.writeHead(200, { "Content-Type": "application/json" });
	response.end(JSON.stringify(result));
}
