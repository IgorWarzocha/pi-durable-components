import type { Models } from "@earendil-works/pi-ai/models";
import { defineCapability, isCapabilityObject } from "./capabilities.ts";

/** Host-owned model catalogues, credentials and refresh. Never copied into configuration. */
export const modelsCapability = defineCapability<Models>(
	"durable.models.v1",
	(value): value is Models =>
		isCapabilityObject(value) &&
		typeof value["getModel"] === "function" &&
		typeof value["getAuth"] === "function" &&
		typeof value["getProviders"] === "function",
);

export interface ComponentState {
	/** Pure path resolution inside an explicitly authorised, persistent namespace. */
	directory(namespace: string): string;
}

export const stateCapability = defineCapability<ComponentState>(
	"durable.state.v1",
	(value): value is ComponentState =>
		isCapabilityObject(value) && typeof value["directory"] === "function",
);

export interface ComponentNetwork {
	/** The host's actual HTTP routing and cancellation capability. */
	readonly fetch: typeof globalThis.fetch;
	/** Explicit authorisation for libraries that own native WebSocket/OAuth transport. */
	readonly nativeSockets?: { readonly environmentId: string };
}

export const networkCapability = defineCapability<ComponentNetwork>(
	"durable.network.v1",
	(value): value is ComponentNetwork =>
		isCapabilityObject(value) &&
		typeof value["fetch"] === "function" &&
		(value["nativeSockets"] === undefined ||
			(isCapabilityObject(value["nativeSockets"]) &&
				typeof value["nativeSockets"]["environmentId"] === "string" &&
				value["nativeSockets"]["environmentId"].length > 0)),
);
