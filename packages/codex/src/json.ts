import type { JsonValue } from "@earendil-works/chord";

/** Keep tool details within Durable's persisted JSON contract. */
export function jsonValue(value: unknown): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean")
		return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (Array.isArray(value)) return value.map(jsonValue);
	if (value && typeof value === "object") {
		const result: Record<string, JsonValue> = {};
		for (const [key, item] of Object.entries(value))
			if (item !== undefined) result[key] = jsonValue(item);
		return result;
	}
	throw new Error("Tool response contains non-JSON data");
}
