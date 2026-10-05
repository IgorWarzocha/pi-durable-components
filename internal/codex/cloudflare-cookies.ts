export interface StoredChatGptCookie {
	name: string;
	value: string;
	domain: string;
	hostOnly: boolean;
	path: string;
	expiresAt?: number | undefined;
}

/** Server-owned session state, never a model tool or browser-cookie import. */
export interface CodexCookieStore {
	requestHeader(url: URL): string | undefined | Promise<string | undefined>;
	storeResponse(
		url: URL,
		setCookieHeaders: readonly string[],
	): void | Promise<void>;
}

const MAX_COOKIE_STATE_BYTES = 64 * 1024;
const MAX_COOKIES = 64;

const EXACT_HOSTS = new Set([
	"chatgpt.com",
	"chat.openai.com",
	"chatgpt-staging.com",
]);
const EXACT_COOKIE_NAMES = new Set([
	"__cf_bm",
	"__cflb",
	"__cfruid",
	"__cfseq",
	"__cfwaitingroom",
	"_cfuvid",
	"cf_clearance",
	"cf_ob_info",
	"cf_use_ob",
]);

export function isChatGptCookieUrl(url: URL): boolean {
	return url.protocol === "https:" && isChatGptHost(url.hostname);
}

export class ChatGptCloudflareCookieStore implements CodexCookieStore {
	private readonly cookies = new Map<string, StoredChatGptCookie>();

	constructor(snapshot: unknown = []) {
		if (
			!Array.isArray(snapshot) ||
			snapshot.length > MAX_COOKIES ||
			new TextEncoder().encode(JSON.stringify(snapshot)).byteLength >
				MAX_COOKIE_STATE_BYTES
		)
			throw new Error("Invalid stored ChatGPT cookie state");
		for (const value of snapshot) {
			if (
				!value ||
				typeof value !== "object" ||
				typeof value.name !== "string" ||
				!isAllowedCookieName(value.name) ||
				typeof value.value !== "string" ||
				!validCookieValue(value.value) ||
				typeof value.domain !== "string" ||
				!isAllowedCookieDomain(value.domain) ||
				typeof value.hostOnly !== "boolean" ||
				typeof value.path !== "string" ||
				!value.path.startsWith("/") ||
				(value.expiresAt !== undefined &&
					(typeof value.expiresAt !== "number" ||
						!Number.isFinite(value.expiresAt)))
			)
				throw new Error("Invalid stored ChatGPT cookie state");
			const cookie: StoredChatGptCookie = {
				name: value.name,
				value: value.value,
				domain: value.domain,
				hostOnly: value.hostOnly,
				path: value.path,
				...(value.expiresAt === undefined
					? {}
					: { expiresAt: value.expiresAt }),
			};
			this.cookies.set(cookieKey(cookie), cookie);
		}
	}

	/** Sensitive host storage payload; do not expose it through Durable results. */
	snapshot(): readonly StoredChatGptCookie[] {
		this.removeExpired();
		return [...this.cookies.values()].map((cookie) => ({ ...cookie }));
	}

	private removeExpired(): void {
		const now = Date.now();
		for (const [key, cookie] of this.cookies)
			if (cookie.expiresAt !== undefined && cookie.expiresAt <= now)
				this.cookies.delete(key);
	}

	requestHeader(url: URL): string | undefined {
		if (!isChatGptCookieUrl(url)) return undefined;
		this.removeExpired();
		const matches: StoredChatGptCookie[] = [];
		for (const cookie of this.cookies.values()) {
			if (
				(cookie.hostOnly
					? url.hostname === cookie.domain
					: domainMatches(url.hostname, cookie.domain)) &&
				pathMatches(url.pathname, cookie.path)
			)
				matches.push(cookie);
		}
		matches.sort((left, right) => right.path.length - left.path.length);
		return matches.length
			? matches.map((cookie) => cookie.name + "=" + cookie.value).join("; ")
			: undefined;
	}

	storeResponse(url: URL, setCookieHeaders: readonly string[]): void {
		if (!isChatGptCookieUrl(url)) return;
		const candidate = new ChatGptCloudflareCookieStore(this.snapshot());
		for (const header of setCookieHeaders) candidate.storeCookie(url, header);
		candidate.removeExpired();
		if (
			candidate.cookies.size > MAX_COOKIES ||
			new TextEncoder().encode(JSON.stringify([...candidate.cookies.values()]))
				.byteLength > MAX_COOKIE_STATE_BYTES
		)
			throw new Error("ChatGPT cookie state exceeded 65536 bytes");
		this.cookies.clear();
		for (const [key, cookie] of candidate.cookies)
			this.cookies.set(key, cookie);
	}

	private storeCookie(url: URL, header: string): void {
		const parts = header.split(";");
		const pair = parts.shift()?.trim();
		const separator = pair?.indexOf("=") ?? -1;
		if (!pair || separator <= 0) return;
		const name = pair.slice(0, separator).trim();
		if (!isAllowedCookieName(name)) return;
		const value = pair.slice(separator + 1).trim();
		if (value && !validCookieValue(value))
			throw new Error("Invalid ChatGPT response cookie");
		let domain = url.hostname;
		let hostOnly = true;
		let path = "/";
		let expiresAt: number | undefined;
		let maxAge: number | undefined;
		for (const part of parts) {
			const [rawName, ...rawValue] = part.trim().split("=");
			const attribute = rawName?.toLowerCase();
			const attributeValue = rawValue.join("=").trim();
			if (attribute === "domain" && attributeValue) {
				const candidate = attributeValue.replace(/^\./, "").toLowerCase();
				if (
					!isAllowedCookieDomain(candidate) ||
					!domainMatches(url.hostname, candidate)
				)
					return;
				domain = candidate;
				hostOnly = false;
			} else if (attribute === "path" && attributeValue.startsWith("/")) {
				path = attributeValue;
			} else if (attribute === "max-age" && /^-?\d+$/.test(attributeValue)) {
				maxAge = Number(attributeValue);
				if (
					!Number.isFinite(maxAge) ||
					!Number.isFinite(Date.now() + maxAge * 1000)
				)
					throw new Error("Invalid ChatGPT response cookie expiry");
			} else if (attribute === "expires" && attributeValue) {
				const parsed = Date.parse(attributeValue);
				if (Number.isFinite(parsed)) expiresAt = parsed;
			}
		}
		if (maxAge !== undefined) expiresAt = Date.now() + maxAge * 1000;
		const key = cookieKey({ domain, path, name, hostOnly });
		if (!value || (expiresAt !== undefined && expiresAt <= Date.now())) {
			this.cookies.delete(key);
			return;
		}
		this.cookies.set(key, { name, value, domain, hostOnly, path, expiresAt });
	}
}

function cookieKey(
	cookie: Pick<StoredChatGptCookie, "domain" | "path" | "name" | "hostOnly">,
): string {
	return [
		cookie.domain,
		cookie.path,
		cookie.name,
		cookie.hostOnly ? "host" : "domain",
	].join("\n");
}

function validCookieValue(value: string): boolean {
	if (!value.length) return false;
	const inner =
		value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
	return /^[\x21-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/.test(inner);
}

function isChatGptHost(host: string): boolean {
	const normalized = host.toLowerCase();
	return (
		EXACT_HOSTS.has(normalized) ||
		normalized.endsWith(".chatgpt.com") ||
		normalized.endsWith(".chatgpt-staging.com")
	);
}

function isAllowedCookieName(name: string): boolean {
	return (
		/^[!#$%&'*+\-.^_`|~0-9a-zA-Z]+$/.test(name) &&
		(EXACT_COOKIE_NAMES.has(name) || name.startsWith("cf_chl_"))
	);
}

function isAllowedCookieDomain(domain: string): boolean {
	return domain === "openai.com" || isChatGptHost(domain);
}

function domainMatches(host: string, domain: string): boolean {
	return host === domain || host.endsWith("." + domain);
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
	return (
		requestPath === cookiePath ||
		requestPath.startsWith(
			cookiePath.endsWith("/") ? cookiePath : cookiePath + "/",
		)
	);
}
