import type { Context } from "@earendil-works/chord";
import type {
	Conversation,
	ConversationId,
	ToolExecutionApi,
} from "@earendil-works/pi-durable";
import type { CodexCookieStore } from "../../../internal/codex/cloudflare-cookies.ts";
import { resolveCodexToolModel } from "../../../internal/codex/config.ts";
import { callingModel } from "../../../internal/codex/durable.ts";
import { codexToolProviderHeaders } from "../../../internal/codex/headers.ts";
import { fetchCodexTool } from "../../../internal/codex/http.ts";
import { jsonValue } from "../../../internal/codex/json.ts";
import {
	resolveCodexToolProvider,
	supportsExecutableCodexTool,
} from "../../../internal/codex/resolve.ts";
import type {
	CodexRuntimeOptions,
	CodexToolProvider,
} from "../../../internal/codex/types.ts";
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
	/** Explicit host-owned egress; omitted by existing native callers. */
	fetch?: typeof globalThis.fetch;
	runtime?: "node" | "workerd";
	cookieStore?: (
		provider: CodexToolProvider,
		context: Context,
	) => CodexCookieStore | Promise<CodexCookieStore>;
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
	const cookieStore = await options.cookieStore?.(provider, context);
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
				...(options.fetch ? { fetch: options.fetch } : {}),
				...(options.runtime ? { runtime: options.runtime } : {}),
				...(cookieStore ? { cookieStore } : {}),
				...(context.abortSignal ? { signal: context.abortSignal } : {}),
			},
		);
	} catch {
		throw new Error(
			"Image request failed or was interrupted. Remote outcome is unknown; do not replay automatically.",
		);
	}
	if (response.status < 200 || response.status >= 300) {
		const challenge =
			response.headers.get("cf-mitigated")?.toLowerCase() === "challenge" ||
			(response.headers.get("server")?.toLowerCase() === "cloudflare" &&
				response.text.trimStart().startsWith("<html"));
		if (
			response.status === 403 &&
			(challenge || response.text.toLowerCase().includes("cloudflare"))
		)
			throw new Error(
				"Image generation failed: HTTP 403 Cloudflare challenge. Try again later.",
			);
		if (
			response.status === 401 ||
			(response.status === 403 &&
				/auth|token|credential|access_enforcement|oauth/i.test(response.text))
		)
			throw new Error(
				"Image generation access was rejected: HTTP " +
					response.status +
					". Ask the user to check credentials and access for the configured provider.",
			);
		throw new Error("Image generation failed: HTTP " + response.status);
	}
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
