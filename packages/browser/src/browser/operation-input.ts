import type { SnapshotResponseLength } from "../cdp/snapshot-contract.ts";
import type { BrowserAction } from "./operation.ts";

export function isRecordValue(
	value: unknown,
): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`${field} must be a non-empty string`);
	}
	return value.trim();
}

export function optionalString(
	value: unknown,
	field: string,
): string | undefined {
	if (value === undefined) return undefined;
	return requiredString(value, field);
}

export function requiredRef(value: unknown, action: BrowserAction): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(
			`${action} requires a ref_id returned by tabs; call tabs first`,
		);
	}
	return value.trim();
}

export function offset(value: unknown, field = "offset", fallback = 0): number {
	if (value === undefined) return fallback;
	if (!Number.isInteger(value) || Number(value) < 0) {
		throw new Error(`${field} must be a non-negative integer`);
	}
	return Number(value);
}

export function line(value: unknown): number {
	const parsed = offset(value, "lineno", 1);
	if (parsed < 1) throw new Error("lineno must be at least 1");
	return parsed;
}

export function elementId(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isInteger(value) || Number(value) < 1) {
		throw new Error("id must be a positive integer from open/find");
	}
	return Number(value);
}

export function responseLength(value: unknown): SnapshotResponseLength {
	if (value === undefined) return "medium";
	if (value !== "short" && value !== "medium" && value !== "long") {
		throw new Error("response_length must be one of: short, medium, long");
	}
	return value;
}
