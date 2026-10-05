import {
	ChatGptCloudflareCookieStore,
	type CodexCookieStore,
	isChatGptCookieUrl,
} from "./cloudflare-cookies.ts";
import { createNodeCodexTransport } from "./http-node.ts";

const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_REDIRECTS = 10;
// Native callers retain the reference's process-lifetime jar. Persistent hosts
// inject their own account-scoped store; both runtimes use the same policy.
const defaultCookies = new ChatGptCloudflareCookieStore();

export interface CodexToolHttpResponse {
	status: number;
	statusText: string;
	headers: Headers;
	text: string;
	/** Host-only sanitiser: apply to decoded strings, never blindly to JSON or image bytes. */
	redact(text: string): string;
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
		cookieStore?: CodexCookieStore;
		/** Explicit host egress, e.g. a Worker service binding. No implicit network fallback. */
		fetch?: typeof globalThis.fetch;
	},
): Promise<CodexToolHttpResponse> {
	const transport =
		options.runtime === "workerd" || options.fetch
			? undefined
			: await createNodeCodexTransport();
	let currentUrl = new URL(url);
	let method = options.method;
	let body = options.body;
	const baseHeaders = new Headers(options.headers);
	const cookies = options.cookieStore ?? defaultCookies;
	const sensitiveCookies = new Map<string, { name: string; value: string }>();
	const rememberCookie = (pair: string) => {
		const separator = pair.indexOf("=");
		const value = pair.slice(separator + 1).trim();
		const name = pair.slice(0, separator).trim();
		if (separator > 0 && value)
			sensitiveCookies.set(`${name}=${value}`, { name, value });
	};
	const redact = (text: string) => {
		for (const { name, value } of sensitiveCookies.values()) {
			// Short control-cookie values (e.g. "0") must not corrupt references,
			// numeric JSON fields or unrelated prose. Exact/header echoes are still private.
			text =
				text === value
					? "[redacted]"
					: text.replaceAll(`${name}=${value}`, `${name}=[redacted]`);
			if (value.length >= 8) text = text.replaceAll(value, "[redacted]");
		}
		return text;
	};
	try {
		for (let redirects = 0; ; redirects += 1) {
			const chatGptRequest = isChatGptCookieUrl(currentUrl);
			const headers = new Headers(baseHeaders);
			if (chatGptRequest) {
				const cookie = await cookies.requestHeader(currentUrl);
				if (cookie) headers.set("cookie", cookie);
			}
			for (const pair of (headers.get("cookie") ?? "").split(";")) {
				rememberCookie(pair);
			}
			const init = {
				...(method ? { method } : {}),
				headers,
				...(body === undefined ? {} : { body }),
				...(options.signal ? { signal: options.signal } : {}),
				redirect: "manual" as const,
			};
			const response = transport
				? await transport.fetch(currentUrl, init)
				: await (options.fetch ?? globalThis.fetch)(currentUrl, init);
			try {
				if (chatGptRequest) {
					const received = response.headers.getSetCookie();
					await cookies.storeResponse(currentUrl, received);
					for (const header of received) {
						const pair = header.split(";", 1)[0] ?? "";
						rememberCookie(pair);
					}
				}
			} catch (error) {
				await response.body?.cancel();
				throw error;
			}
			const location = redirectLocation(
				response.status,
				response.headers.get("location"),
			);
			if (!location) {
				const text = await readBoundedText(
					response,
					options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
				);
				return {
					status: response.status,
					statusText: response.statusText,
					headers: new Headers([...response.headers.entries()]),
					text,
					redact,
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
