import type { JsonValue, UiCleanup } from "./lifecycle.ts";

export interface UiSnapshot {
	sequence: number;
	value: JsonValue;
}

/** Validate wire snapshots without trusting a transport's TypeScript types. */
export function parseUiSnapshot(value: unknown): UiSnapshot {
	if (
		typeof value !== "object" ||
		value === null ||
		!("sequence" in value) ||
		!("value" in value)
	)
		throw new TypeError("Expected a UI snapshot");
	const sequence = value.sequence;
	if (
		typeof sequence !== "number" ||
		!Number.isSafeInteger(sequence) ||
		sequence < 0
	)
		throw new TypeError(
			"UI snapshot sequence must be a nonnegative safe integer",
		);
	assertJson(value.value, new Set());
	return { sequence, value: value.value };
}

function assertJson(
	value: unknown,
	ancestors: Set<object>,
): asserts value is JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean")
		return;
	if (typeof value === "number" && Number.isFinite(value)) return;
	if (typeof value !== "object" || value === null || ancestors.has(value))
		throw new TypeError("UI snapshot value must be JSON");
	if (
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) !== Object.prototype &&
		Object.getPrototypeOf(value) !== null
	)
		throw new TypeError("UI snapshot value must be JSON");
	ancestors.add(value);
	if (Array.isArray(value)) {
		for (const entry of value) assertJson(entry, ancestors);
	} else {
		for (const entry of Object.values(value)) assertJson(entry, ancestors);
	}
	ancestors.delete(value);
}

/** Host-owned state and transport. Sequence numbers must be nonnegative safe integers. */
export interface UiBinding {
	getSnapshot(): UiSnapshot;
	subscribe(
		onSnapshot: (snapshot: UiSnapshot) => void,
		onError: (error: unknown) => void,
	): UiCleanup;
	call(
		action: string,
		input: JsonValue,
		options: { signal: AbortSignal },
	): Promise<JsonValue>;
	stream?(
		name: string,
		input: JsonValue,
		options: { signal: AbortSignal },
	): AsyncIterable<JsonValue>;
}

export interface UiComponentContext<State> {
	id: string;
	signal: AbortSignal;
	state: {
		getSnapshot(): State;
		subscribe(listener: () => void): () => void;
	};
	call(
		action: string,
		input: JsonValue,
		options?: { signal?: AbortSignal },
	): Promise<JsonValue>;
	stream(
		name: string,
		input: JsonValue,
		options?: { signal?: AbortSignal },
	): AsyncIterable<JsonValue>;
}
