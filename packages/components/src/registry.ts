import { createHash, timingSafeEqual } from "node:crypto";

export function registryUrl(value = "https://registry.npmjs.org/"): URL {
	const url = new URL(value);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	)
		throw new Error("Registry must be a credential-free HTTPS URL");
	if (!url.pathname.endsWith("/")) url.pathname += "/";
	return url;
}

export function approvedTarball(value: string, registry: URL): URL {
	const url = new URL(value);
	if (
		url.origin !== registry.origin ||
		url.username ||
		url.password ||
		url.hash
	)
		throw new Error(
			"Tarball must use the approved registry origin without credentials",
		);
	return url;
}

export function byteLimit(value: number | undefined, fallback: number): number {
	const limit = value ?? fallback;
	if (!Number.isSafeInteger(limit) || limit <= 0)
		throw new Error("Byte limits must be positive safe integers");
	return limit;
}

/** Never follows a redirect or asks fetch to attach ambient credentials. */
export async function fetchBytes(
	fetch: typeof globalThis.fetch,
	url: URL,
	limit: number,
	signal?: AbortSignal,
): Promise<Uint8Array> {
	signal?.throwIfAborted();
	const response = await fetch(url.href, {
		redirect: "error",
		credentials: "omit",
		referrerPolicy: "no-referrer",
		...(signal ? { signal } : {}),
	});
	if (
		!response.ok ||
		response.redirected ||
		(response.url && response.url !== url.href)
	) {
		await response.body?.cancel();
		throw new Error(
			`Registry request failed or changed URL: ${url.href} (${response.status})`,
		);
	}
	if (!response.body)
		throw new Error("Registry returned an empty response body");
	const reader = response.body.getReader();
	const abort = () => {
		void reader.cancel(signal?.reason).catch(() => {});
	};
	signal?.addEventListener("abort", abort, { once: true });
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			signal?.throwIfAborted();
			const part = await reader.read();
			if (part.done) break;
			size += part.value.byteLength;
			if (size > limit)
				throw new Error(`Registry response exceeds ${limit} bytes`);
			chunks.push(part.value);
		}
		signal?.throwIfAborted();
	} catch (error) {
		await reader.cancel().catch(() => {});
		throw error;
	} finally {
		signal?.removeEventListener("abort", abort);
		reader.releaseLock();
	}
	const result = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}

export function parseJson(bytes: Uint8Array): unknown {
	return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

/** SRI chooses the strongest supported algorithm; weaker matches cannot override it. */
export function verifyIntegrity(bytes: Uint8Array, integrity: string): string {
	const ranks = ["sha512", "sha384", "sha256", "sha1"] as const;
	const tokens = integrity
		.trim()
		.split(/\s+/)
		.map((token) => {
			const match = /^(sha512|sha384|sha256|sha1)-([A-Za-z0-9+/]+={0,2})$/.exec(
				token,
			);
			if (!match) throw new Error("Invalid or unsupported registry integrity");
			return { algorithm: match[1], digest: match[2] ?? "" };
		});
	for (const algorithm of ranks) {
		const candidates = tokens.filter((token) => token.algorithm === algorithm);
		if (!candidates.length) continue;
		const actual = createHash(algorithm).update(bytes).digest();
		if (
			!candidates.some(({ digest }) => {
				const expected = Buffer.from(digest, "base64");
				return (
					expected.toString("base64") === digest &&
					expected.length === actual.length &&
					timingSafeEqual(expected, actual)
				);
			})
		)
			throw new Error("Registry tarball integrity mismatch");
		return createHash("sha256").update(bytes).digest("hex");
	}
	throw new Error("Registry metadata has no supported integrity");
}
