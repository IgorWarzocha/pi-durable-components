import {
	browserCapability,
	type ComponentInstance,
	type ComponentRequest,
	defineCapability,
	isCapabilityObject,
	stateCapability,
} from "@howaboua/pi-durable-components";
import {
	type BrowserRuntimeConfig,
	type BrowserToolOptions,
	createBrowserExtension,
	nodeArtifactStore,
} from "./index.ts";

/** Grants native CDP/private state and configured remote routes, never ambient Chrome discovery. */
export interface BrowserComponentOptions
	extends BrowserRuntimeConfig,
		BrowserToolOptions {
	discover: NonNullable<BrowserRuntimeConfig["discover"]>;
	start: NonNullable<BrowserRuntimeConfig["start"]>;
}

export const browserOptions = defineCapability<BrowserComponentOptions>(
	"howaboua.browser.options.v1",
	(value): value is BrowserComponentOptions => {
		if (
			!isCapabilityObject(value) ||
			typeof value["stateDirectory"] !== "string" ||
			typeof value["discover"] !== "function" ||
			typeof value["start"] !== "function"
		)
			return false;
		const artifacts = value["artifacts"];
		return (
			isCapabilityObject(artifacts) &&
			["path", "write", "read", "remove", "entries"].every(
				(key) => typeof artifacts[key] === "function",
			)
		);
	},
);

function baseline(request: ComponentRequest): BrowserComponentOptions {
	const configuration = request.configuration;
	if (
		Object.keys(configuration).some(
			(key) => !["voiceOnly", "environmentArtifactDirectory"].includes(key),
		) ||
		(configuration["voiceOnly"] !== undefined &&
			typeof configuration["voiceOnly"] !== "boolean") ||
		(configuration["environmentArtifactDirectory"] !== undefined &&
			typeof configuration["environmentArtifactDirectory"] !== "string")
	)
		throw new Error("Invalid browser configuration");
	const stateDirectory = request.capabilities
		.get(stateCapability)
		.directory("browser");
	const browser = request.capabilities.get(browserCapability);
	return {
		stateDirectory,
		artifacts: nodeArtifactStore(stateDirectory),
		discover: (signal) => browser.discover(signal),
		start: (signal) => browser.start(signal),
		...(typeof configuration["voiceOnly"] === "boolean"
			? { voiceOnly: configuration["voiceOnly"] }
			: {}),
		...(typeof configuration["environmentArtifactDirectory"] === "string"
			? {
					environmentArtifactDirectory:
						configuration["environmentArtifactDirectory"],
				}
			: {}),
	};
}

export function createComponent(
	request: ComponentRequest,
): ComponentInstance<ReturnType<typeof createBrowserExtension>> {
	const api = createBrowserExtension(
		request.capabilities.has(browserOptions.id)
			? request.capabilities.get(browserOptions)
			: baseline(request),
	);
	return {
		extensions: [api.extension],
		api,
		retention: "harness",
		afterClose: () => api.close(),
	};
}
