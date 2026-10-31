import type { Harness } from "@earendil-works/pi-durable";
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
import {
	createImageGenerationExtension,
	type ImageGenerationToolOptions,
	normalizeCodexToolRouteConfig,
} from "./index.ts";

/** All original route options, with explicit egress and conversation history access. */
export interface ImagegenComponentOptions extends ImageGenerationToolOptions {
	fetch: typeof globalThis.fetch;
	conversation: NonNullable<ImageGenerationToolOptions["conversation"]>;
}

export const imagegenOptions = defineCapability<ImagegenComponentOptions>(
	"howaboua.imagegen.options.v1",
	(value): value is ImagegenComponentOptions =>
		isCapabilityObject(value) &&
		isCapabilityObject(value["models"]) &&
		typeof value["models"]["getModel"] === "function" &&
		typeof value["fetch"] === "function" &&
		typeof value["conversation"] === "function",
);

const configuration = Type.Object(
	{
		runtime: Type.Optional(
			Type.Union([Type.Literal("node"), Type.Literal("workerd")]),
		),
		allowCodexProviderFallback: Type.Optional(Type.Boolean()),
		routes: Type.Optional(Type.Unknown()),
	},
	{ additionalProperties: false },
);

function baseline(
	request: ComponentRequest,
	conversation: ImagegenComponentOptions["conversation"],
): ImagegenComponentOptions {
	if (!Check(configuration, request.configuration))
		throw new Error("Invalid imagegen configuration");
	const { routes, ...options } = request.configuration;
	return {
		...options,
		models: request.capabilities.get(modelsCapability),
		fetch: request.capabilities.get(networkCapability).fetch,
		conversation,
		...(routes === undefined
			? {}
			: { routes: normalizeCodexToolRouteConfig(routes) }),
	};
}

export function createComponent(
	request: ComponentRequest,
): ComponentInstance<ReturnType<typeof createImageGenerationExtension>> {
	let harness: Harness | undefined;
	const advanced = request.capabilities.has(imagegenOptions.id);
	const options = advanced
		? request.capabilities.get(imagegenOptions)
		: baseline(request, async (id, context) => {
				if (!harness)
					throw new Error("Imagegen component is not bound to a Harness");
				return harness.conversation(id, context);
			});
	const cookies = createComponentCookieStores();
	const api = createImageGenerationExtension({
		...options,
		cookieStore:
			options.cookieStore ?? ((provider) => cookies.forProvider(provider)),
	});
	return {
		extensions: [api],
		api,
		retention: advanced ? "idle" : "harness",
		bind(binding) {
			if (!advanced) harness = binding.harness;
		},
		afterClose() {
			harness = undefined;
			cookies.close();
		},
	};
}
