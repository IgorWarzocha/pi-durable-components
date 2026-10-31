import {
	type ComponentInstance,
	type ComponentRequest,
	defineCapability,
	isCapabilityObject,
	modelsCapability,
	networkCapability,
} from "@howaboua/pi-durable-components";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { createComponentCookieStores } from "../../../internal/codex/component-cookies.ts";
import { DEFAULT_WEB_SEARCH_MODEL } from "./contract.ts";
import {
	createWebSearchExtension,
	normalizeCodexToolRouteConfig,
	type WebSearchToolOptions,
} from "./index.ts";

/** Explicit network and credential-resolution grant; never reads host auth files. */
export interface WebComponentOptions extends WebSearchToolOptions {
	fetch: typeof globalThis.fetch;
}

export const webOptions = defineCapability<WebComponentOptions>(
	"howaboua.web.options.v1",
	(value): value is WebComponentOptions =>
		isCapabilityObject(value) &&
		isCapabilityObject(value["models"]) &&
		typeof value["models"]["getModel"] === "function" &&
		typeof value["fetch"] === "function",
);

const configuration = Type.Object(
	{
		model: Type.Optional(Type.String()),
		runtime: Type.Optional(
			Type.Union([Type.Literal("node"), Type.Literal("workerd")]),
		),
		allowCodexProviderFallback: Type.Optional(Type.Boolean()),
		routes: Type.Optional(Type.Unknown()),
	},
	{ additionalProperties: false },
);

function baseline(request: ComponentRequest): WebComponentOptions {
	if (!Check(configuration, request.configuration))
		throw new Error("Invalid web configuration");
	const { routes, ...options } = request.configuration;
	return {
		...options,
		models: request.capabilities.get(modelsCapability),
		fetch: request.capabilities.get(networkCapability).fetch,
		...(routes === undefined
			? {}
			: { routes: normalizeCodexToolRouteConfig(routes) }),
	};
}

export function createComponent(
	request: ComponentRequest,
): ComponentInstance<ReturnType<typeof createWebSearchExtension>> {
	const options = request.capabilities.has(webOptions.id)
		? request.capabilities.get(webOptions)
		: baseline(request);
	const cookies = createComponentCookieStores();
	const api = createWebSearchExtension({
		...options,
		model: options.model ?? DEFAULT_WEB_SEARCH_MODEL,
		cookieStore:
			options.cookieStore ?? ((provider) => cookies.forProvider(provider)),
	});
	return {
		extensions: [api],
		api,
		retention: "idle",
		afterClose: () => cookies.close(),
	};
}
