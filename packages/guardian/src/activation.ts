import {
	type ComponentInstance,
	type ComponentRequest,
	defineCapability,
	isCapabilityObject,
	networkCapability,
	nodeExecutionCapability,
} from "@howaboua/pi-durable-components";
import { createGuardian, type GuardianOptions } from "./index.ts";

/** Policy is an explicit snapshot; nativeRegex explicitly grants isolated native regex workers. */
export const guardianOptions = defineCapability<GuardianOptions>(
	"howaboua.guardian.options.v1",
	(value): value is GuardianOptions =>
		isCapabilityObject(value) &&
		(value["enabled"] === undefined || typeof value["enabled"] === "boolean") &&
		(value["nativeRegex"] === undefined ||
			typeof value["nativeRegex"] === "boolean") &&
		(value["fetch"] === undefined || typeof value["fetch"] === "function") &&
		(value["cwdForConversation"] === undefined ||
			typeof value["cwdForConversation"] === "function"),
);

function baseline(request: ComponentRequest): GuardianOptions {
	const configuration = request.configuration;
	if (
		Object.keys(configuration).some(
			(key) => !["rules", "enabled", "nativeRegex"].includes(key),
		) ||
		(configuration["enabled"] !== undefined &&
			typeof configuration["enabled"] !== "boolean") ||
		(configuration["nativeRegex"] !== undefined &&
			typeof configuration["nativeRegex"] !== "boolean")
	)
		throw new Error("Invalid guardian configuration");
	if (configuration["nativeRegex"] === true)
		request.capabilities.get(nodeExecutionCapability);
	return {
		...(configuration["rules"] === undefined
			? {}
			: { rules: configuration["rules"] }),
		...(typeof configuration["enabled"] === "boolean"
			? { enabled: configuration["enabled"] }
			: {}),
		...(typeof configuration["nativeRegex"] === "boolean"
			? { nativeRegex: configuration["nativeRegex"] }
			: {}),
		...(request.capabilities.has(networkCapability.id)
			? { fetch: request.capabilities.get(networkCapability).fetch }
			: {}),
	};
}

export function createComponent(
	request: ComponentRequest,
): ComponentInstance<ReturnType<typeof createGuardian>> {
	const options = request.capabilities.has(guardianOptions.id)
		? request.capabilities.get(guardianOptions)
		: baseline(request);
	const api = createGuardian({
		...options,
		fetch:
			options.fetch ??
			(() => {
				throw new Error("Guardian review requires explicit host egress");
			}),
	});
	// The host composes api.prepareRequest/observeCompletion with its owned provider
	// and calls api.invalidate on trust, model, branch or execution namespace changes.
	return {
		extensions: [api.extension],
		api,
		retention: "harness",
		afterClose: () => api.close(),
	};
}
