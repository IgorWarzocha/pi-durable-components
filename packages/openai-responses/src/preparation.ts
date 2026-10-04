import {
	type Api,
	getDeclaredTools,
	type Model,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { normalizeCodexConfigurationUpdates } from "./configuration-updates.ts";
import { createGrammarToolInputProperties } from "./constrained-sampling.ts";
import { buildRequestBody } from "./openai-codex/request-body.ts";
import {
	applyResponsesLiteRequest,
	isResponsesLiteRequest,
	namespaceExistingResponsesLiteRequest,
	prepareResponsesLiteRequestImages,
} from "./openai-codex/responses-lite.ts";
import { supportsResponsesLiteModel } from "./openai-codex/responses-lite-model.ts";
import type {
	OpenAICodexStreamOptions,
	ResponsesBody,
} from "./openai-codex/types.ts";
import { normalizeResponsesToolHistory } from "./openai-responses/tool-history.ts";

export function useResponsesLite(
	setting: boolean | "auto",
	model: Model<Api>,
	context: TranscriptContext,
): boolean {
	return setting === "auto"
		? supportsResponsesLiteModel(model.id) &&
				getDeclaredTools(context.messages).some(
					(tool) =>
						tool.constrainedSampling &&
						tool.constrainedSampling.type === "grammar",
				)
		: setting;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Payload hooks may replace the body, but must preserve its transport contract. */
export function assertResponsesBody(
	value: unknown,
): asserts value is ResponsesBody {
	if (
		!isRecord(value) ||
		typeof value["model"] !== "string" ||
		!value["model"] ||
		typeof value["store"] !== "boolean" ||
		value["stream"] !== true ||
		!Array.isArray(value["input"]) ||
		!isRecord(value["text"]) ||
		typeof value["text"]["verbosity"] !== "string" ||
		!Array.isArray(value["include"]) ||
		!value["include"].every((item) => typeof item === "string") ||
		!["auto", "none", "required"].includes(String(value["tool_choice"])) ||
		typeof value["parallel_tool_calls"] !== "boolean" ||
		(value["previous_response_id"] !== undefined &&
			typeof value["previous_response_id"] !== "string") ||
		(value["instructions"] !== undefined &&
			typeof value["instructions"] !== "string") ||
		(value["tools"] !== undefined && !Array.isArray(value["tools"]))
	) {
		throw new Error("Invalid Codex Responses request body");
	}
}

export async function prepareRequestBody<TApi extends Api>(
	model: Model<TApi>,
	context: TranscriptContext,
	options: OpenAICodexStreamOptions | undefined,
	responsesLite: boolean,
): Promise<ResponsesBody> {
	options?.signal?.throwIfAborted();
	const compat = model.compat;
	const grammarToolInputProperties = createGrammarToolInputProperties(
		getDeclaredTools(context.messages),
		responsesLite ||
			(compat &&
				"supportsOpenAIGrammarTools" in compat &&
				compat.supportsOpenAIGrammarTools === true) ||
			false,
	);
	let body = buildRequestBody(model, context, {
		...options,
		grammarToolInputProperties,
	});
	const replacement = await options?.onPayload?.(body, model);
	if (replacement !== undefined) {
		assertResponsesBody(replacement);
		body = replacement;
	}
	assertResponsesBody(body);
	if (responsesLite) {
		body = isResponsesLiteRequest(body)
			? namespaceExistingResponsesLiteRequest({
					...body,
					parallel_tool_calls: false,
				})
			: applyResponsesLiteRequest(body);
		body = await prepareResponsesLiteRequestImages(body, options?.signal);
	}
	if (!body.previous_response_id)
		body = { ...body, input: normalizeResponsesToolHistory(body.input) };
	options?.signal?.throwIfAborted();
	return normalizeCodexConfigurationUpdates(body);
}
