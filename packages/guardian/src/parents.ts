import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { TaskId } from "@earendil-works/pi-durable";
import { isRecord, serializeReview } from "./review.ts";
/** Structural host-composition contract. Guardian never imports a provider implementation. */
export interface CompletionObservation {
	responseId: string;
	provider: string;
	api: string;
	model: string;
	sessionId: string | undefined;
	url: string;
	transport: "sse" | "websocket";
	requestBody: string;
	canonicalSubscription: boolean;
}
export type Parent = {
	agent: string;
	observation: CompletionObservation;
	context: unknown;
	runId: TaskId;
	calls: Set<string>;
};

export const prepareParentRequest = (
	body: unknown,
	model: { api: string; id: string; baseUrl?: string | undefined },
	eligible: boolean,
) => {
	if (!isRecord(body)) return;
	// The one-shot reviewer already owns its action-bound attribution.
	if (
		model.id === "codex-auto-review" ||
		(isRecord(body["client_metadata"]) &&
			body["client_metadata"]["x-openai-subagent"] === "guardian")
	)
		return;
	const metadata = isRecord(body["client_metadata"])
		? { ...body["client_metadata"] }
		: {};
	delete metadata["guardian_credits_requested"];
	delete metadata["parent_response_id"];
	body["client_metadata"] = metadata;
	if (
		!eligible ||
		model.api !== "openai-codex-responses" ||
		model.id === "codex-auto-review" ||
		metadata["x-openai-subagent"] === "guardian" ||
		![
			"https://chatgpt.com/backend-api",
			"https://chatgpt.com/backend-api/codex",
			"https://chatgpt.com/backend-api/codex/responses",
		].includes(model.baseUrl?.replace(/\/+$/, "") ?? "")
	)
		return;
	metadata["guardian_credits_requested"] = "true";
};

export function captureParent(
	observation: CompletionObservation,
	message: AssistantMessage,
	runId: TaskId,
	agent: string,
): Parent | undefined {
	try {
		const body: unknown = JSON.parse(observation.requestBody);
		if (
			!isRecord(body) ||
			body["model"] !== observation.model ||
			body["previous_response_id"] ||
			!Array.isArray(body["input"])
		)
			return undefined;
		const input = body["input"];
		const lite =
			isRecord(input[0]) &&
			input[0]["type"] === "additional_tools" &&
			input[0]["role"] === "developer" &&
			Array.isArray(input[0]["tools"]);
		if (typeof body["instructions"] !== "string" && !lite) return undefined;
		if (
			input.some(
				(item) =>
					isRecord(item) &&
					(["compaction", "item_reference"].includes(String(item["type"])) ||
						(Array.isArray(item["content"]) &&
							item["content"].some(
								(part) =>
									isRecord(part) &&
									["input_image", "input_file", "input_audio"].includes(
										String(part["type"]),
									),
							))),
			)
		)
			return undefined;
		const calls = new Set(
			message.content
				.filter((item) => item.type === "toolCall")
				.map((item) => item.id),
		);
		if (!calls.size || calls.size > 128) return undefined;
		const evidence = JSON.parse(
			serializeReview({
				instructions: body["instructions"],
				input,
				tools: body["tools"],
			}),
		);
		return { observation, context: evidence, runId, calls, agent };
	} catch {
		return undefined;
	}
}
