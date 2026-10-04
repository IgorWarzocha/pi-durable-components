import type {
	CachedWebSocketContinuationState,
	CachedWebSocketRequestBodyResult,
	ResponsesBody,
	WebSocketContinuationDecision,
} from "./types.ts";

function requestBodyForWebSocketContinuationComparison(
	body: ResponsesBody,
): ResponsesBody {
	const {
		input: _input,
		previous_response_id: _previousResponseId,
		// Request metadata may carry per-turn transport fields such as the
		// Responses Lite marker. It does not change conversation continuity.
		client_metadata: _clientMetadata,
		...rest
	} = body;
	return rest as ResponsesBody;
}

export function responseInputsEqual(
	a: readonly unknown[] | undefined,
	b: readonly unknown[] | undefined,
): boolean {
	const left = a ?? [];
	const right = b ?? [];
	return (
		left.length === right.length &&
		left.every((item, index) => responsesValuesEqual(item, right[index]))
	);
}

function canonicalResponseValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalResponseValue);
	if (!value || typeof value !== "object") return value;
	const record = value as Record<string, unknown>;
	const canonical: Record<string, unknown> = {};
	for (const key of Object.keys(record).sort()) {
		if (key === "internal_chat_message_metadata_passthrough") continue;
		if (
			key === "logprobs" &&
			record["type"] === "output_text" &&
			Array.isArray(record[key]) &&
			record[key].length === 0
		)
			continue;
		if (
			key === "status" &&
			record[key] === "completed" &&
			(record["type"] === "function_call" ||
				record["type"] === "custom_tool_call")
		)
			continue;
		canonical[key] = canonicalResponseValue(record[key]);
	}
	return canonical;
}

function responsesValuesEqual(a: unknown, b: unknown): boolean {
	return (
		JSON.stringify(canonicalResponseValue(a)) ===
		JSON.stringify(canonicalResponseValue(b))
	);
}

function requestBodiesMatchExceptInput(
	a: ResponsesBody,
	b: ResponsesBody,
): boolean {
	return responsesValuesEqual(
		requestBodyForWebSocketContinuationComparison(a),
		requestBodyForWebSocketContinuationComparison(b),
	);
}

function getCachedWebSocketInputDelta(
	body: ResponsesBody,
	continuation: CachedWebSocketContinuationState,
): { delta?: unknown[] | undefined; decision: WebSocketContinuationDecision } {
	if (!requestBodiesMatchExceptInput(body, continuation.lastRequestBody)) {
		return { decision: "body_mismatch" };
	}

	const currentInput = body.input ?? [];
	const baseline = [
		...(continuation.lastRequestBody.input ?? []),
		...continuation.lastResponseItems,
	];
	if (currentInput.length < baseline.length) {
		return { decision: "input_shorter_than_baseline" };
	}

	const prefix = currentInput.slice(0, baseline.length);
	if (!responseInputsEqual(prefix, baseline)) {
		// Matching tool result IDs cannot prove the preceding request or response
		// provenance. A changed history must reach the server as a full request.
		return { decision: "input_prefix_mismatch" };
	}

	return { delta: currentInput.slice(baseline.length), decision: "delta" };
}

export function buildCachedWebSocketRequestBody(
	continuation: CachedWebSocketContinuationState | undefined,
	body: ResponsesBody,
): CachedWebSocketRequestBodyResult {
	if (!continuation) {
		return { body, decision: "no_continuation" };
	}

	const { delta, decision } = getCachedWebSocketInputDelta(body, continuation);
	if (!delta) {
		return { body, decision };
	}
	if (!continuation.lastResponseId) {
		return { body, decision: "missing_previous_response_id" };
	}

	return {
		body: {
			...body,
			previous_response_id: continuation.lastResponseId,
			input: delta,
		},
		decision: "delta",
	};
}
