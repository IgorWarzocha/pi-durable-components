import { defineCapability, isCapabilityObject } from "./capabilities.ts";

/** Explicit authority to connect to a host-selected Chrome and request its launch.
 * Callbacks own discovery and launch policy; consumers never infer user paths or services. */
export interface BrowserGrant {
	discover(signal?: AbortSignal): Promise<string>;
	start(signal?: AbortSignal): Promise<string>;
}

export const browserCapability = defineCapability<BrowserGrant>(
	"durable.browser.v1",
	(value): value is BrowserGrant =>
		isCapabilityObject(value) &&
		typeof value["discover"] === "function" &&
		typeof value["start"] === "function",
);
