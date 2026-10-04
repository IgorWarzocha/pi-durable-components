const DEFAULT_REMOTE_NODE_PATH = "node";

export interface BrowserRouteConfig {
	aliases: Record<string, string>;
	hosts: string[];
	remoteNodePath: string;
}

interface BrowserRouteConfigInput {
	aliases?: Record<string, string>;
	hosts?: string[];
	remoteNodePath?: string;
}

const ROUTE_NAME = /^[A-Za-z0-9_.-]+$/;
const REMOTE_WORD = /^[A-Za-z0-9_./:$@=+-]+$/;

function normalizeBrowserHostName(
	value: unknown,
	field = "browser host",
): string {
	if (typeof value !== "string" || !ROUTE_NAME.test(value)) {
		throw new Error(
			`${field} must contain only letters, digits, dot, dash or underscore`,
		);
	}
	return value;
}

function remoteWord(value: unknown, field: string): string {
	if (typeof value !== "string" || !value || !REMOTE_WORD.test(value)) {
		throw new Error(`${field} contains unsupported shell characters`);
	}
	return value;
}

export function normalizeBrowserRouteConfig(
	value: unknown,
): BrowserRouteConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("pi-browser config must be an object");
	}
	const input = value as BrowserRouteConfigInput;
	const rawHosts = input.hosts ?? [];
	if (!Array.isArray(rawHosts)) {
		throw new Error("pi-browser config hosts must be an array");
	}
	const hosts = rawHosts.map((name) =>
		normalizeBrowserHostName(name, "pi-browser host name"),
	);
	if (new Set(hosts).size !== hosts.length) {
		throw new Error("pi-browser config hosts must be unique");
	}
	const rawAliases = input.aliases ?? {};
	if (typeof rawAliases !== "object" || Array.isArray(rawAliases)) {
		throw new Error("pi-browser config aliases must be an object");
	}
	const aliases: Record<string, string> = {};
	for (const [rawAlias, rawTarget] of Object.entries(rawAliases)) {
		const alias = normalizeBrowserHostName(rawAlias, "pi-browser alias");
		const target = normalizeBrowserHostName(
			rawTarget,
			`pi-browser alias ${alias}`,
		);
		if (!hosts.includes(target)) {
			throw new Error(
				`pi-browser alias ${alias} targets unknown host ${target}`,
			);
		}
		aliases[alias] = target;
	}
	return {
		aliases,
		hosts,
		remoteNodePath: remoteWord(
			input.remoteNodePath ?? DEFAULT_REMOTE_NODE_PATH,
			"pi-browser remoteNodePath",
		),
	};
}
