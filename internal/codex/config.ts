import type { CodexModel } from "./types.ts";

export interface CodexToolRouteConfig {
	providers: Record<string, Record<string, string>>;
}

function nonEmptyName(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim())
		throw new Error(field + " must be a non-empty string");
	return value.trim();
}

/** Parse the host-loaded pi-codex-tools.json without reading the native filesystem. */
export function normalizeCodexToolRouteConfig(
	value: unknown,
): CodexToolRouteConfig {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("pi-codex-tools config must be an object");
	const rawProviders = "providers" in value ? (value.providers ?? {}) : {};
	if (
		!rawProviders ||
		typeof rawProviders !== "object" ||
		Array.isArray(rawProviders)
	)
		throw new Error("pi-codex-tools providers must be an object");
	const providers: Record<string, Record<string, string>> = Object.create(null);
	for (const [provider, rawModels] of Object.entries(rawProviders)) {
		const name = nonEmptyName(
			provider,
			"pi-codex-tools provider name",
		).toLowerCase();
		if (!rawModels || typeof rawModels !== "object" || Array.isArray(rawModels))
			throw new Error("pi-codex-tools provider " + name + " must be an object");
		const models: Record<string, string> = Object.create(null);
		for (const [canonical, alias] of Object.entries(rawModels))
			models[
				nonEmptyName(canonical, "pi-codex-tools model name").toLowerCase()
			] = nonEmptyName(alias, "pi-codex-tools model alias");
		providers[name] = models;
	}
	return { providers };
}

export function isCodexToolRoute(
	config: CodexToolRouteConfig,
	model: CodexModel | undefined,
): boolean {
	const provider = model?.provider.trim().toLowerCase();
	return Boolean(provider && Object.hasOwn(config.providers, provider));
}

export function resolveCodexToolModel(
	config: CodexToolRouteConfig,
	model: CodexModel | undefined,
	canonical: string,
): string {
	const provider = model?.provider.trim().toLowerCase();
	const aliases =
		provider && Object.hasOwn(config.providers, provider)
			? config.providers[provider]
			: undefined;
	return aliases?.[canonical.trim().toLowerCase()] || canonical;
}
