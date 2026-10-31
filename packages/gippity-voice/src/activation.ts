import type { ConversationId } from "@earendil-works/pi-durable";
import {
	audioLeaseCapability,
	type ComponentInstance,
	type ComponentRequest,
	defineCapability,
	isCapabilityObject,
	modelsCapability,
	nativeWebRtcAudioCapability,
	networkCapability,
	nodeExecutionCapability,
	stateCapability,
} from "@howaboua/pi-durable-components";
import { componentSettings } from "./component-settings.ts";
import { createGippityVoice, type GippityVoiceOptions } from "./controller.ts";

/** Both voice products resolve this same application-owned atomic lease. */
export const audioLease = audioLeaseCapability;

export const gippityVoiceOptions = defineCapability<GippityVoiceOptions>(
	"howaboua.gippity-voice.options.v1",
	(value): value is GippityVoiceOptions =>
		isCapabilityObject(value) &&
		typeof value["namespace"] === "string" &&
		typeof value["instructions"] === "string" &&
		isCapabilityObject(value["audio"]) &&
		typeof value["audio"]["launch"] === "function" &&
		value["audio"]["namespace"] === value["namespace"] &&
		isCapabilityObject(value["lease"]) &&
		typeof value["lease"]["acquire"] === "function",
);

export const gippityVoiceTarget = defineCapability<ConversationId>(
	"howaboua.gippity-voice.target.v1",
	(value): value is ConversationId =>
		typeof value === "number" && Number.isSafeInteger(value) && value > 0,
);

export function createComponent(
	request: ComponentRequest,
): ComponentInstance<ReturnType<typeof createGippityVoice>> {
	const lease = request.capabilities.get(audioLease);
	const advanced = request.capabilities.has(gippityVoiceOptions.id);
	const target = request.capabilities.has(gippityVoiceTarget.id)
		? request.capabilities.get(gippityVoiceTarget)
		: gippityVoiceTarget.parse(request.configuration["conversationId"]);
	if (!advanced) request.capabilities.get(modelsCapability);
	const options = advanced
		? request.capabilities.get(gippityVoiceOptions)
		: baselineOptions(request);
	if (options.lease !== lease)
		throw new Error("GipPity must use the application's shared audio lease");
	const api = createGippityVoice(options);
	return {
		extensions: [api.extension],
		api,
		retention: "idle",
		bind({ harness }) {
			api.controls.bindHarness(harness, target);
		},
		beforeClose: (context) => api.controls.close(context),
	};
}

function baselineOptions(request: ComponentRequest): GippityVoiceOptions {
	const audio = request.capabilities.get(nativeWebRtcAudioCapability);
	const native = request.capabilities.get(nodeExecutionCapability);
	const network = request.capabilities.get(networkCapability);
	if (
		native.environmentId !== audio.environmentId ||
		network.nativeSockets?.environmentId !== audio.environmentId
	)
		throw new Error(
			"GipPity audio, native and network grants must share a namespace",
		);
	const instructions = request.configuration["instructions"];
	if (typeof instructions !== "string" || !instructions.trim())
		throw new Error("GipPity configuration requires explicit instructions");
	const instanceName = request.configuration["instanceName"];
	if (instanceName !== undefined && typeof instanceName !== "string")
		throw new Error("Voice instanceName must be a string");
	const config = request.configuration["settings"] ?? {};
	const directory = request.capabilities
		.get(stateCapability)
		.directory(`gippity-voice${instanceName ? `.${instanceName}` : ""}`);
	return {
		namespace: audio.environmentId,
		audio: { namespace: audio.environmentId, launch: () => audio.launch() },
		lease: request.capabilities.get(audioLease),
		instructions,
		providerEnv: {},
		config,
		settings: componentSettings(directory, config),
		allowContextSummary: request.configuration["allowContextSummary"] === true,
		...(instanceName === undefined ? {} : { instanceName }),
	};
}
