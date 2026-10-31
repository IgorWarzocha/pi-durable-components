import {
	audioLeaseCapability,
	type ComponentInstance,
	type ComponentRequest,
	defineCapability,
	isCapabilityObject,
	modelsCapability,
	networkCapability,
	nodeExecutionCapability,
	pcm24AudioCapability,
	stateCapability,
} from "@howaboua/pi-durable-components";
import { componentSettings } from "./component-settings.ts";
import { DEFAULT_CONFIG, normalizeConfig } from "./config.ts";
import type { GrokVoiceOptions } from "./host.ts";
import { createGrokVoice } from "./index.ts";

/** Both voice products resolve this same application-owned atomic lease. */
export const audioLease = audioLeaseCapability;

export const grokVoiceOptions = defineCapability<GrokVoiceOptions>(
	"howaboua.grok-voice.options.v1",
	(value): value is GrokVoiceOptions =>
		isCapabilityObject(value) &&
		typeof value["capabilities"] === "function" &&
		isCapabilityObject(value["lease"]) &&
		typeof value["lease"]["acquire"] === "function" &&
		typeof value["socket"] === "function",
);

export function createComponent(
	request: ComponentRequest,
): ComponentInstance<ReturnType<typeof createGrokVoice>> {
	const advanced = request.capabilities.has(grokVoiceOptions.id);
	if (!advanced) request.capabilities.get(modelsCapability);
	const options = advanced
		? request.capabilities.get(grokVoiceOptions)
		: baselineOptions(request);
	const lease = request.capabilities.get(audioLease);
	if (options.lease !== lease)
		throw new Error("Grok must use the application's shared audio lease");
	const api = createGrokVoice(options);
	return {
		extensions: [api.extension],
		api,
		retention: "idle",
		beforeClose: () => api.close(),
	};
}

function baselineOptions(request: ComponentRequest): GrokVoiceOptions {
	const audio = request.capabilities.get(pcm24AudioCapability);
	const native = request.capabilities.get(nodeExecutionCapability);
	const network = request.capabilities.get(networkCapability);
	if (
		native.environmentId !== audio.environmentId ||
		network.nativeSockets?.environmentId !== audio.environmentId
	)
		throw new Error(
			"Grok audio, native and network grants must share a namespace",
		);
	const instanceName = request.configuration["instanceName"];
	if (instanceName !== undefined && typeof instanceName !== "string")
		throw new Error("Voice instanceName must be a string");
	const config = normalizeConfig(
		request.configuration["settings"] ?? {},
		DEFAULT_CONFIG,
	);
	const directory = request.capabilities
		.get(stateCapability)
		.directory(`grok-voice${instanceName ? `.${instanceName}` : ""}`);
	return {
		lease: request.capabilities.get(audioLease),
		capabilities: (environment) =>
			environment?.id === audio.environmentId
				? {
						environmentId: audio.environmentId,
						audio: (settings) => audio.create(settings),
					}
				: undefined,
		config,
		settings: componentSettings(directory, config),
		allowContext: request.configuration["allowContext"] === true,
		...(instanceName === undefined ? {} : { instanceName }),
	};
}
