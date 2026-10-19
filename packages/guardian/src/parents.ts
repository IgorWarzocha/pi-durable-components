import type { Context } from "@earendil-works/chord";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	HookApi,
	LiveState,
	TaskId,
	ToolHookCall,
} from "@earendil-works/pi-durable";
import {
	type ToolOrigin,
	ToolOriginDoc,
} from "../../execution/src/tool-origin.ts";
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

/** Hooks have read-only document access. Follow native parents to the cell or model admission. */
export async function resolveToolOrigin(
	api: HookApi,
	call: ToolHookCall,
	live: LiveState | undefined,
	context: Context,
): Promise<ToolOrigin> {
	let origin: ToolOrigin = {
		conversationId: api.conversationId,
		taskId: api.taskId,
		callId: call.id,
	};
	const seen = new Set<TaskId>();
	while (!seen.has(origin.taskId)) {
		seen.add(origin.taskId);
		const inherited = (
			await api.snapshot(ToolOriginDoc, origin.taskId, context)
		)?.origin;
		if (inherited) return inherited;
		const slot = live?.nestedTools?.find(
			(slot) => slot.taskId === origin.taskId && slot.callId === origin.callId,
		);
		const parent =
			origin.taskId === api.taskId
				? call.parent
				: slot && { taskId: slot.parentTaskId, callId: slot.parentCallId };
		if (!parent) return origin;
		origin = { conversationId: api.conversationId, ...parent };
	}
	throw new Error("Cyclic tool parent provenance");
}

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
		// Codex carries standing instructions in a developer input item, including after
		// Lite's additional_tools item. Empty standing instructions may be absent entirely.
		if (
			body["instructions"] !== undefined &&
			typeof body["instructions"] !== "string"
		)
			return undefined;
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
