import {
	type JsonValue,
	parseUiSnapshot,
	type UiTransport,
} from "@howaboua/pi-durable-ui";

async function* readNDJSON(
	url: string,
	token: string,
	signal: AbortSignal,
): AsyncIterable<JsonValue> {
	const response = await fetch(url, {
		headers: { Authorization: `Bearer ${token}` },
		signal,
	});
	if (!response.ok) throw new Error(await response.text());
	if (!response.body) throw new Error("Missing response body");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const item = await reader.read();
			buffer += decoder.decode(item.value, { stream: !item.done });
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				yield JSON.parse(buffer.slice(0, newline)) as JsonValue;
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
			}
			if (buffer.length > 4 * 1024 * 1024)
				throw new Error("Transport frame too large");
			if (item.done) {
				if (buffer) throw new Error("Truncated transport frame");
				return;
			}
		}
	} finally {
		try {
			await reader.cancel();
		} catch (error) {
			if (!signal.aborted) throw error;
		} finally {
			reader.releaseLock();
		}
	}
}

export function httpTransport(id: string, token: string): UiTransport {
	const query = `id=${encodeURIComponent(id)}`;
	return {
		async *snapshots({ signal }) {
			for await (const value of readNDJSON(`/updates?${query}`, token, signal))
				yield parseUiSnapshot(value);
		},
		async call(action, input, { signal }) {
			const response = await fetch(`/call?${query}`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ action, input }),
				signal,
			});
			if (!response.ok) throw new Error(await response.text());
			return (await response.json()) as JsonValue;
		},
		stream(name, _input, { signal }) {
			return readNDJSON(
				`/stream?${query}&name=${encodeURIComponent(name)}`,
				token,
				signal,
			);
		},
	};
}
