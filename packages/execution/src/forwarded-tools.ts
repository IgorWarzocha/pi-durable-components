import {
	type ExecutionResultReceipt,
	type JsonValue,
	parseExecutionResultReceipt,
} from "./presentation.ts";

export type ForwardedToolStatus =
	| "pending"
	| "running"
	| "completed"
	| "failed"
	| "aborted"
	| "interrupted";

/** Display data only; omitted arguments are never substituted into execution. */
export interface ForwardedToolCall {
	readonly callId: string;
	readonly parentCallId: string;
	readonly name: string;
	readonly arguments?: JsonValue;
	readonly status: ForwardedToolStatus;
	readonly result: ExecutionResultReceipt | null;
	readonly omittedFields: readonly ("arguments" | "result")[];
}

/** Cumulative cell snapshot. Repeated exec/wait observations retain call identities. */
export interface ForwardedToolCalls {
	readonly version: 1;
	readonly cellId: string;
	readonly calls: readonly ForwardedToolCall[];
	readonly omittedCalls: number;
}

function object(value: unknown): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		(Object.getPrototypeOf(value) !== Object.prototype &&
			Object.getPrototypeOf(value) !== null)
	)
		throw new TypeError("Invalid forwarded tool calls object");
	return value as Record<string, unknown>;
}

function string(value: unknown): string {
	if (typeof value !== "string" || !value)
		throw new TypeError("Invalid forwarded tool identity");
	return value;
}

function json(value: unknown, ancestors = new Set<object>()): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean")
		return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (!value || typeof value !== "object" || ancestors.has(value))
		throw new TypeError("Invalid forwarded tool JSON");
	ancestors.add(value);
	try {
		return Array.isArray(value)
			? value.map((item: unknown) => json(item, ancestors))
			: Object.fromEntries(
					Object.entries(object(value)).map(([key, item]) => [
						key,
						json(item, ancestors),
					]),
				);
	} finally {
		ancestors.delete(value);
	}
}

/** Old receipts return null. A present malformed receipt is an error, never an inferred call. */
export function parseForwardedToolCalls(
	details: unknown,
): ForwardedToolCalls | null {
	if (
		!details ||
		typeof details !== "object" ||
		!("forwardedToolCalls" in details)
	)
		return null;
	const fields = object(details.forwardedToolCalls);
	if (fields["version"] !== 1)
		throw new TypeError("Unsupported forwarded tool calls version");
	const cellId = string(fields["cellId"]);
	if (!/^[1-9][0-9]*$/.test(cellId) || !Number.isSafeInteger(Number(cellId)))
		throw new TypeError("Invalid forwarded cell ID");
	const omittedCalls = fields["omittedCalls"];
	if (
		typeof omittedCalls !== "number" ||
		!Number.isSafeInteger(omittedCalls) ||
		omittedCalls < 0 ||
		!Array.isArray(fields["calls"])
	)
		throw new TypeError("Invalid forwarded tool call list");
	const ids = new Set<string>();
	const calls = fields["calls"].map((value: unknown): ForwardedToolCall => {
		const call = object(value);
		const callId = string(call["callId"]);
		if (ids.has(callId))
			throw new TypeError("Duplicate forwarded tool call ID");
		ids.add(callId);
		const status = call["status"];
		if (
			status !== "pending" &&
			status !== "running" &&
			status !== "completed" &&
			status !== "failed" &&
			status !== "aborted" &&
			status !== "interrupted"
		)
			throw new TypeError("Invalid forwarded tool status");
		const omitted = call["omittedFields"];
		if (
			!Array.isArray(omitted) ||
			omitted.some(
				(field: unknown) => field !== "arguments" && field !== "result",
			) ||
			new Set(omitted).size !== omitted.length
		)
			throw new TypeError("Invalid forwarded omitted fields");
		const omittedFields: ("arguments" | "result")[] = omitted.map(
			(field: unknown) => {
				if (field === "arguments" || field === "result") return field;
				throw new TypeError("Invalid forwarded omitted field");
			},
		);
		if (
			!("arguments" in call) !== omittedFields.includes("arguments") ||
			(omittedFields.includes("result") && call["result"] !== null)
		)
			throw new TypeError("Inconsistent forwarded omitted fields");
		return {
			callId,
			parentCallId: string(call["parentCallId"]),
			name: string(call["name"]),
			...(omittedFields.includes("arguments")
				? {}
				: { arguments: json(call["arguments"]) }),
			status,
			result: parseExecutionResultReceipt(json(call["result"])),
			omittedFields,
		};
	});
	return { version: 1, cellId, calls, omittedCalls };
}
