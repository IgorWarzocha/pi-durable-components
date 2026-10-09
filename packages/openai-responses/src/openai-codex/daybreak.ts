import type { Api, Model } from "@earendil-works/pi-ai";
import {
	buildSSEHeaders,
	extractAccountId,
	resolveCodexUrl,
} from "./headers.ts";
import { osInfoReady } from "./node-runtime.ts";
import { combineAbortSignals } from "./sse.ts";
import type { OpenAICodexStreamOptions, ResponsesBody } from "./types.ts";

type Catalog = Map<string, string[]>;
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;

async function discover(
	url: string,
	headers: Headers,
	options: OpenAICodexStreamOptions,
): Promise<Catalog> {
	const timeout = new AbortController();
	const timer = setTimeout(() => timeout.abort(), 5000);
	const combined = combineAbortSignals([options.signal, timeout.signal]);
	try {
		const response = await (options.fetch ?? globalThis.fetch)(url, {
			headers,
			// Workers support manual, not error. Non-2xx responses fail below.
			redirect: "manual",
			signal: combined.signal,
		});
		if (!response.ok || !response.body) {
			await response.body?.cancel();
			throw new Error("Catalog unavailable");
		}
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.byteLength;
				if (size > MAX_CATALOG_BYTES) throw new Error("Catalog too large");
				chunks.push(value);
			}
		} finally {
			await reader.cancel().catch(() => undefined);
			reader.releaseLock();
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		const data: unknown = JSON.parse(new TextDecoder().decode(bytes));
		if (
			!data ||
			typeof data !== "object" ||
			!("models" in data) ||
			!Array.isArray(data.models)
		)
			throw new Error("Invalid catalog");
		const catalog: Catalog = new Map();
		for (const entry of data.models) {
			if (!entry || typeof entry !== "object" || typeof entry.slug !== "string")
				continue;
			const programs: unknown = entry.available_access_programs?.cyber;
			if (
				Array.isArray(programs) &&
				programs.every((program) => typeof program === "string")
			)
				catalog.set(entry.slug, programs);
		}
		return catalog;
	} finally {
		clearTimeout(timer);
		combined.cleanup();
	}
}

/** One provider owns eligibility evidence. No credentials are retained in cache keys. */
export function createDaybreakAccessResolver(originator: string) {
	const catalogs = new Map<
		string,
		{ expires: number; catalog: Catalog | undefined }
	>();
	const fetchIdentities = new WeakMap<
		NonNullable<OpenAICodexStreamOptions["fetch"]>,
		number
	>();
	let nextFetchIdentity = 0;
	return {
		clear() {
			catalogs.clear();
		},
		async apply(
			model: Model<Api>,
			body: ResponsesBody,
			options: OpenAICodexStreamOptions,
			enabled: boolean,
		): Promise<ResponsesBody> {
			options.signal?.throwIfAborted();
			if (!options.apiKey) throw new Error("No Codex credentials available");
			await osInfoReady;
			const headers = buildSSEHeaders(
				model.headers,
				options.headers,
				extractAccountId(options.apiKey),
				options.apiKey,
				undefined,
				false,
				originator,
			);
			headers.set("accept", "application/json");
			headers.delete("content-type");
			const url = new URL(resolveCodexUrl(model.baseUrl));
			url.pathname = url.pathname.replace(/\/responses$/, "/models");
			url.searchParams.set("client_version", "0.162.0");
			let fetchIdentity = 0;
			if (options.fetch) {
				fetchIdentity =
					fetchIdentities.get(options.fetch) ?? ++nextFetchIdentity;
				fetchIdentities.set(options.fetch, fetchIdentity);
			}
			const digest = await globalThis.crypto.subtle.digest(
				"SHA-256",
				new TextEncoder().encode(
					JSON.stringify([url.href, [...headers].sort(), fetchIdentity]),
				),
			);
			const key = Array.from(new Uint8Array(digest), (byte) =>
				byte.toString(16).padStart(2, "0"),
			).join("");
			let cached = catalogs.get(key);
			if (!cached || cached.expires <= Date.now()) {
				let catalog: Catalog | undefined;
				try {
					catalog = await discover(url.href, headers, options);
				} catch {
					options.signal?.throwIfAborted();
				}
				options.signal?.throwIfAborted();
				cached = {
					catalog,
					expires: Date.now() + (catalog ? 300_000 : 30_000),
				};
				catalogs.delete(key);
				if (catalogs.size >= 8) catalogs.delete(catalogs.keys().next().value!);
				catalogs.set(key, cached);
			}
			options.signal?.throwIfAborted();
			const programs = cached.catalog?.get(body.model);
			const cyber = enabled
				? programs?.includes("daybreak_blue")
					? "daybreak_blue"
					: programs?.includes("daybreak_red")
						? "daybreak_red"
						: undefined
				: programs?.includes("standard")
					? "standard"
					: undefined;
			if (enabled && !cyber)
				throw new Error(
					`Daybreak support for model ${body.model} could not be confirmed by the connected server`,
				);
			const result = { ...body };
			if (cyber) result["access_programs"] = { cyber };
			else delete result["access_programs"];
			return result;
		},
	};
}
