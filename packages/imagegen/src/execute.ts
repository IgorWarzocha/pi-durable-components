import type { Context } from "@earendil-works/chord";
import type {
	Conversation,
	ConversationId,
	ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { resolveCodexToolModel } from "../../../internal/codex/config.ts";
import { callingModel } from "../../../internal/codex/durable.ts";
import { codexToolProviderHeaders } from "../../../internal/codex/headers.ts";
import { fetchCodexTool } from "../../../internal/codex/http.ts";
import { jsonValue } from "../../../internal/codex/json.ts";
import {
	resolveCodexToolProvider,
	supportsExecutableCodexTool,
} from "../../../internal/codex/resolve.ts";
import type { CodexRuntimeOptions } from "../../../internal/codex/types.ts";
import { saveGeneratedImages } from "./artifacts.ts";
import {
	IMAGE_GENERATION_UNSUPPORTED_MESSAGE,
	IMAGE_MODEL,
	type ImagegenArgs,
	type ImageResponse,
} from "./contract.ts";
import { recentConversationImageUrls } from "./history.ts";
import { buildImageGenerationRequest } from "./request.ts";

export interface ImageGenerationToolOptions extends CodexRuntimeOptions {
	/** Durable 1.0.2's tool conversation handle has no context reader. */
	conversation?: (
		id: ConversationId,
		context: Context,
	) => Promise<Pick<Conversation, "context"> | undefined>;
}

function parseImageResponse(text: string): ImageResponse {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error("failed to decode image generation response");
	}
	if (
		!parsed ||
		typeof parsed !== "object" ||
		!("data" in parsed) ||
		!Array.isArray(parsed.data)
	)
		throw new Error("image generation returned no image data");
	const data = parsed.data.map((item: unknown) => {
		if (
			!item ||
			typeof item !== "object" ||
			!("b64_json" in item) ||
			typeof item.b64_json !== "string" ||
			!item.b64_json.length
		)
			throw new Error("image generation returned no image data");
		return { b64_json: item.b64_json };
	});
	const result: ImageResponse = { data };
	const metadata = parsed as Record<string, unknown>;
	for (const key of ["background", "quality", "size"] as const) {
		if (key in metadata) {
			const value = metadata[key];
			if (typeof value !== "string" && value !== null)
				throw new Error("image generation returned invalid " + key);
			result[key] = value;
		}
	}
	if ("usage" in parsed) result.usage = jsonValue(parsed.usage);
	return result;
}

export async function executeCodexImageGeneration(
	args: ImagegenArgs,
	api: ToolExecutionApi,
	context: Context,
	options: ImageGenerationToolOptions,
) {
	context.abortSignal?.throwIfAborted();
	const env = api.env;
	if (!env)
		throw new Error("imagegen requires a conversation execution environment");
	const current = await callingModel(api, options, context);
	if (!supportsExecutableCodexTool(current, options, true))
		throw new Error(IMAGE_GENERATION_UNSUPPORTED_MESSAGE);
	let recentImages: string[] | undefined;
	if (args.num_last_images_to_include != null) {
		const conversation = await options.conversation?.(
			api.conversationId,
			context,
		);
		if (!conversation)
			throw new Error(
				"Recent image selection requires an active conversation context reader",
			);
		recentImages = recentConversationImageUrls(
			(await conversation.context(context)).messages,
			args.num_last_images_to_include,
		);
		if (recentImages.length !== args.num_last_images_to_include)
			throw new Error(
				"requested the last " +
					args.num_last_images_to_include +
					" conversation images, but only " +
					recentImages.length +
					" were available",
			);
	}
	const request = await buildImageGenerationRequest(
		args,
		recentImages,
		env,
		context,
		resolveCodexToolModel(
			options.routes ?? { providers: {} },
			current,
			IMAGE_MODEL,
		),
	);
	const provider = await resolveCodexToolProvider(current, options, context);
	const headers = codexToolProviderHeaders(provider);
	headers.set("accept", "application/json");
	headers.set("x-codex-image-turn-id", api.callId);
	let response;
	try {
		response = await fetchCodexTool(
			provider.baseUrl.replace(/\/+$/, "") + "/images/" + request.operation,
			{
				method: "POST",
				headers,
				body: JSON.stringify(request.body),
				...(context.abortSignal ? { signal: context.abortSignal } : {}),
			},
		);
	} catch (error) {
		throw new Error(
			"Image request failed or was interrupted. Remote outcome is unknown; do not replay automatically: " +
				(error instanceof Error ? error.message : String(error)),
			{ cause: error },
		);
	}
	if (response.status < 200 || response.status >= 300)
		throw new Error(
			"image generation failed: HTTP " + response.status + " " + response.text,
		);
	try {
		const saved = await saveGeneratedImages(
			env,
			context,
			parseImageResponse(response.text),
			response.headers.get("x-codex-imagegen-request-id") ?? undefined,
		);
		return {
			...saved,
			content: current && !current.input.includes("image") ? [] : saved.content,
		};
	} catch (error) {
		throw new Error(
			"Image service returned success, but decoding or saving artifacts failed. Do not replay this request: " +
				(error instanceof Error ? error.message : String(error)),
			{ cause: error },
		);
	}
}
