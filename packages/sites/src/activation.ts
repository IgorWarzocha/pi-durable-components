import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
	type ComponentInstance,
	type ComponentRequest,
	defineCapability,
	isCapabilityObject,
	modelsCapability,
	networkCapability,
	nodeExecutionCapability,
} from "@howaboua/pi-durable-components";
import { Type } from "typebox";
import { Check } from "typebox/value";
import {
	createNativeSitesProjectCapability,
	createSitesExtension,
	type SitesOptions,
} from "./index.ts";

export interface SitesComponentOptions extends SitesOptions {
	fetch: typeof globalThis.fetch;
}

/** Grants canonical ChatGPT egress and a project capability for the exact execution namespace. */
export const sitesOptions = defineCapability<SitesComponentOptions>(
	"howaboua.sites.options.v1",
	(value): value is SitesComponentOptions =>
		isCapabilityObject(value) &&
		isCapabilityObject(value["models"]) &&
		typeof value["models"]["getAuth"] === "function" &&
		typeof value["projectForEnvironment"] === "function" &&
		typeof value["fetch"] === "function",
);

const configuration = Type.Object(
	{ providerId: Type.Optional(Type.String()) },
	{ additionalProperties: false },
);

function baseline(request: ComponentRequest): SitesComponentOptions {
	if (!Check(configuration, request.configuration))
		throw new Error("Invalid sites configuration");
	const execution = request.capabilities.get(nodeExecutionCapability);
	return {
		...request.configuration,
		models: request.capabilities.get(modelsCapability),
		fetch: request.capabilities.get(networkCapability).fetch,
		projectForEnvironment(environment) {
			if (
				environment.id !== execution.environmentId ||
				!(environment instanceof NodeExecutionEnv)
			)
				return undefined;
			return createNativeSitesProjectCapability(environment);
		},
	};
}

export function createComponent(
	request: ComponentRequest,
): ComponentInstance<ReturnType<typeof createSitesExtension>> {
	const api = createSitesExtension(
		request.capabilities.has(sitesOptions.id)
			? request.capabilities.get(sitesOptions)
			: baseline(request),
	);
	return { extensions: [api], api, retention: "idle" };
}
