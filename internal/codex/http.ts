import { isChatGptCookieUrl } from "./cloudflare-cookies.ts";
import { createNodeCodexTransport } from "./http-node.ts";

const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_REDIRECTS = 10;

export interface CodexToolHttpResponse {
	status: number;
	statusText: string;
	headers: Headers;
	text: string;
}

export async function fetchCodexTool(
	url: string,
	options: {
		method?: string;
		headers?: Headers;
		body?: string;
		signal?: AbortSignal | null;
		maxResponseBytes?: number;
		runtime?: "node" | "workerd";
	},
): Promise<CodexToolHttpResponse> {
	const transport =
		options.runtime === "workerd"
			? undefined
			: await createNodeCodexTransport();
	let currentUrl = new URL(url);
	let method = options.method;
	let body = options.body;
	const baseHeaders = new Headers(options.headers);
	try {
		for (let redirects = 0; ; redirects += 1) {
			const chatGptRequest = isChatGptCookieUrl(currentUrl);
			const headers = new Headers(baseHeaders);
			const init = {
				...(method ? { method } : {}),
				headers,
				...(body === undefined ? {} : { body }),
				...(options.signal ? { signal: options.signal } : {}),
				redirect: "manual" as const,
			};
			const response = transport
				? await transport.fetch(currentUrl, init)
				: await globalThis.fetch(currentUrl, init);
			const location = redirectLocation(
				response.status,
				response.headers.get("location"),
			);
			if (!location) {
				return {
					status: response.status,
					statusText: response.statusText,
					headers: new Headers([...response.headers.entries()]),
					text: await readBoundedText(
						response,
						options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
					),
				};
			}
			if (redirects >= MAX_REDIRECTS) {
				await response.body?.cancel();
				throw new Error(
					"Codex tool request exceeded " + MAX_REDIRECTS + " redirects",
				);
			}
			let nextUrl: URL;
			try {
				nextUrl = new URL(location, currentUrl);
			} catch (error) {
				await response.body?.cancel();
				throw error;
			}
			if (
				options.runtime === "workerd" &&
				currentUrl.protocol === "https:" &&
				nextUrl.protocol !== "https:"
			) {
				await response.body?.cancel();
				throw new Error("Codex tool request refused redirect outside HTTPS");
			}
			if (chatGptRequest && !isChatGptCookieUrl(nextUrl)) {
				await response.body?.cancel();
				throw new Error(
					"Codex tool request refused redirect outside ChatGPT: " +
						nextUrl.origin,
				);
			}
			if (nextUrl.origin !== currentUrl.origin) {
				baseHeaders.delete("authorization");
				baseHeaders.delete("chatgpt-account-id");
				baseHeaders.delete("cookie");
				baseHeaders.delete("proxy-authorization");
				baseHeaders.delete("host");
			}
			if (
				(response.status === 303 &&
					method?.toUpperCase() !== "GET" &&
					method?.toUpperCase() !== "HEAD") ||
				((response.status === 301 || response.status === 302) &&
					method?.toUpperCase() === "POST")
			) {
				method = "GET";
				body = undefined;
				baseHeaders.delete("content-encoding");
				baseHeaders.delete("content-language");
				baseHeaders.delete("content-location");
				baseHeaders.delete("content-type");
				baseHeaders.delete("content-length");
			}
			await response.body?.cancel();
			currentUrl = nextUrl;
		}
	} finally {
		await transport?.close();
	}
}

function redirectLocation(
	status: number,
	location: string | null,
): string | undefined {
	return location && [301, 302, 303, 307, 308].includes(status)
		? location
		: undefined;
}

async function readBoundedText(
	response: Response | import("undici").Response,
	maxBytes: number,
): Promise<string> {
	const contentLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(contentLength) && contentLength > maxBytes) {
		await response.body?.cancel();
		throw new Error("Codex tool response exceeded " + maxBytes + " bytes");
	}
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let total = 0;
	let text = "";
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			total += chunk.value.byteLength;
			if (total > maxBytes) {
				await reader.cancel();
				throw new Error("Codex tool response exceeded " + maxBytes + " bytes");
			}
			text += decoder.decode(chunk.value, { stream: true });
		}
		return text + decoder.decode();
	} finally {
		reader.releaseLock();
	}
}
