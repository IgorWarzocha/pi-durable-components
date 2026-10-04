import type { Context } from "@earendil-works/chord";
import type { Api, Model, Models, Usage } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { ViewImageContent } from "./codec.ts";

const DESCRIPTION_PROMPT =
	"Describe this image in detail. Output only the image description, no other commentary";

export async function describeImage(
	image: ViewImageContent,
	models: Models,
	caller: ModelRef,
	configured: ModelRef | undefined,
	context: Context,
): Promise<{ description: string; usage: Usage }> {
	const ref = configured ?? {
		provider: caller.provider,
		modelId: "gpt-6-luna",
	};
	const model = models.getModel(ref.provider, ref.modelId);
	if (!model)
		throw new Error(
			`view_image description model not found: ${ref.provider}/${ref.modelId}`,
		);
	if (!model.input.includes("image"))
		throw new Error(
			`view_image description model does not support image inputs: ${ref.provider}/${ref.modelId}`,
		);
	context.abortSignal?.throwIfAborted();
	const reply = await models.completeSimple(
		model,
		{
			systemPrompt: DESCRIPTION_PROMPT,
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Describe the image" }, image],
					timestamp: Date.now(),
				},
			],
		},
		{
			reasoning: "low",
			...(context.abortSignal ? { signal: context.abortSignal } : {}),
			onPayload: prepareDescriptionPayload,
		},
	);
	context.abortSignal?.throwIfAborted();
	if (reply.stopReason === "error" || reply.stopReason === "aborted") {
		throw new Error(
			`view_image description failed: ${reply.errorMessage ?? reply.stopReason}`,
		);
	}
	const description = reply.content
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("")
		.trim();
	if (!description) throw new Error("view_image description returned no text");
	return { description, usage: reply.usage };
}

/** Supported pi-ai payload transform, restricted to this component's own description request. */
function prepareDescriptionPayload(
	payload: unknown,
	model: Model<Api>,
): unknown {
	if (
		model.api !== "openai-responses" &&
		model.api !== "openai-codex-responses"
	)
		return undefined;
	if (!payload || typeof payload !== "object")
		throw new Error("view_image description expected a Responses payload");
	const body = payload as Record<string, unknown>;
	const reasoning = body["reasoning"];
	const text = body["text"];
	return {
		...body,
		text: {
			...(text && typeof text === "object" ? text : {}),
			verbosity: "low",
		},
		...(reasoning && typeof reasoning === "object"
			? { reasoning: { ...reasoning, summary: "auto" } }
			: {}),
	};
}
