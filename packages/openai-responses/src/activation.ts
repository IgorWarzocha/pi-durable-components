import {
	type ComponentInstance,
	type ComponentRequest,
	defineCapability,
	isCapabilityObject,
	networkCapability,
} from "@howaboua/pi-durable-components";
import {
	createOpenAIResponsesProvider,
	type OpenAIResponsesProvider,
	type OpenAIResponsesProviderOptions,
} from "./index.ts";

export type ResponsesComponentOptions =
	| (OpenAIResponsesProviderOptions<"openai-responses"> & { mode: "direct" })
	| (OpenAIResponsesProviderOptions<"openai-codex-responses"> & {
			mode?: "codex";
	  });

/** Grants the provider's HTTP/WebSocket/OAuth transports, not ambient credential files. */
export const openaiResponsesOptions =
	defineCapability<ResponsesComponentOptions>(
		"howaboua.openai-responses.options.v1",
		(value): value is ResponsesComponentOptions =>
			isCapabilityObject(value) &&
			(value["mode"] === undefined ||
				value["mode"] === "codex" ||
				value["mode"] === "direct") &&
			(value["runtime"] === undefined ||
				value["runtime"] === "node" ||
				value["runtime"] === "workerd") &&
			(value["id"] === undefined || typeof value["id"] === "string") &&
			(value["baseUrl"] === undefined ||
				typeof value["baseUrl"] === "string") &&
			(value["websocketFallback"] === undefined ||
				value["websocketFallback"] === "sse" ||
				value["websocketFallback"] === "error") &&
			(value["transport"] === undefined ||
				value["transport"] === "sse" ||
				value["transport"] === "websocket" ||
				value["transport"] === "websocket-cached" ||
				value["transport"] === "auto") &&
			(value["responsesLite"] === undefined ||
				typeof value["responsesLite"] === "boolean" ||
				value["responsesLite"] === "auto") &&
			(value["daybreak"] === undefined ||
				typeof value["daybreak"] === "boolean") &&
			(value["forceCachedWebSockets"] === undefined ||
				typeof value["forceCachedWebSockets"] === "boolean") &&
			(value["originator"] === undefined ||
				typeof value["originator"] === "string") &&
			(value["models"] === undefined || Array.isArray(value["models"])),
	);

function baseline(request: ComponentRequest): ResponsesComponentOptions {
	const allowed = [
		"mode",
		"runtime",
		"id",
		"baseUrl",
		"websocketFallback",
		"transport",
		"responsesLite",
		"daybreak",
		"forceCachedWebSockets",
		"originator",
	];
	if (Object.keys(request.configuration).some((key) => !allowed.includes(key)))
		throw new Error("Invalid openai-responses configuration");
	if (!request.capabilities.get(networkCapability).nativeSockets)
		throw new Error(
			"OpenAI Responses requires explicit native socket and OAuth transport approval",
		);
	return openaiResponsesOptions.parse(request.configuration);
}

type ResponsesProvider =
	| OpenAIResponsesProvider<"openai-responses">
	| OpenAIResponsesProvider<"openai-codex-responses">;

export function createComponent(
	request: ComponentRequest,
): ComponentInstance<ResponsesProvider> {
	const options = request.capabilities.has(openaiResponsesOptions.id)
		? request.capabilities.get(openaiResponsesOptions)
		: baseline(request);
	const api =
		options.mode === "direct"
			? createOpenAIResponsesProvider(options)
			: createOpenAIResponsesProvider(options);
	return {
		providers: [api],
		api,
		retention: "harness",
		afterClose: () => api.close(),
	};
}
