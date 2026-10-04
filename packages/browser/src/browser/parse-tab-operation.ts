import { parseKeyChord } from "../cdp/actions/key.ts";
import type { BrowserAction, BrowserOperation } from "./operation.ts";
import {
	elementId,
	isRecordValue,
	optionalString,
	requiredString,
} from "./operation-input.ts";

/** Validate tab effects after the envelope has rejected unknown fields and required a tab reference. */
export function parseTabOperation(
	action: BrowserAction,
	refId: string,
	value: Record<string, unknown>,
): BrowserOperation {
	if (action === "network" || action === "show" || action === "close")
		return { action, ref_id: refId };
	if (action === "navigate") {
		return {
			action,
			ref_id: refId,
			url: requiredString(value["url"], "url"),
		};
	}
	if (action === "evaluate") {
		return {
			action,
			ref_id: refId,
			expression: requiredString(value["expression"], "expression"),
		};
	}
	if (action === "click") {
		const id = elementId(value["id"]);
		const selector = optionalString(value["selector"], "selector");
		const hasX = value["x"] !== undefined;
		const hasY = value["y"] !== undefined;
		let coordinates: { x: number; y: number } | undefined;
		if (hasX !== hasY) {
			throw new Error("click coordinates require both x and y");
		}
		if (
			hasX &&
			(typeof value["x"] !== "number" ||
				!Number.isFinite(value["x"]) ||
				typeof value["y"] !== "number" ||
				!Number.isFinite(value["y"]))
		) {
			throw new Error("x and y must be finite CSS-pixel numbers");
		}
		if (typeof value["x"] === "number" && typeof value["y"] === "number") {
			coordinates = { x: value["x"], y: value["y"] };
		}
		if (
			Number(id !== undefined) + Number(Boolean(selector)) + Number(hasX) !==
			1
		) {
			throw new Error("click requires exactly one of id, selector, or x+y");
		}
		if (id !== undefined) return { action, ref_id: refId, id };
		if (selector) return { action, ref_id: refId, selector };
		if (coordinates) {
			return { action, ref_id: refId, ...coordinates };
		}
		throw new Error("click requires id, selector, or x+y");
	}
	if (action === "type") {
		if (typeof value["text"] !== "string" || value["text"].length === 0) {
			throw new Error("text must be a non-empty string");
		}
		const id = elementId(value["id"]);
		return {
			action,
			ref_id: refId,
			...(id === undefined ? {} : { id }),
			text: value["text"],
		};
	}
	if (action === "screenshot" || action === "html") {
		const id = elementId(value["id"]);
		const selector = optionalString(value["selector"], "selector");
		if (id !== undefined && selector) {
			throw new Error(`${action} accepts id or selector, not both`);
		}
		return {
			action,
			ref_id: refId,
			...(id === undefined ? {} : { id }),
			...(selector ? { selector } : {}),
		};
	}
	if (action === "fill") {
		const id = elementId(value["id"]);
		const selector = optionalString(value["selector"], "selector");
		if (Number(id !== undefined) + Number(selector !== undefined) !== 1) {
			throw new Error("fill requires exactly one of id or selector");
		}
		const fillValue = value["value"];
		if (typeof fillValue !== "string" && typeof fillValue !== "boolean") {
			throw new Error("value must be text or a boolean for checkbox/radio");
		}
		if (id !== undefined)
			return { action, ref_id: refId, id, value: fillValue };
		if (selector) return { action, ref_id: refId, selector, value: fillValue };
		throw new Error("fill requires id or selector");
	}
	if (action === "press") {
		const key = requiredString(value["key"], "key");
		parseKeyChord(key);
		return { action, ref_id: refId, key };
	}
	if (action === "wait") {
		const conditions = ["selector", "text", "url_includes"] as const;
		const provided = conditions.filter((field) => value[field] !== undefined);
		const field = provided[0];
		if (provided.length !== 1 || !field) {
			throw new Error(
				"wait requires exactly one of selector, text, or url_includes",
			);
		}
		const match = value[field];
		if (typeof match !== "string" || !match.trim()) {
			throw new Error(`${field} must be a non-empty string`);
		}
		const timeout = value["timeout_ms"] ?? 10_000;
		if (
			!Number.isInteger(timeout) ||
			Number(timeout) < 1 ||
			Number(timeout) > 60_000
		) {
			throw new Error("timeout_ms must be an integer from 1 to 60000");
		}
		const base = {
			action,
			ref_id: refId,
			timeout_ms: Number(timeout),
		} as const;
		if (field === "selector") return { ...base, selector: match };
		if (field === "text") return { ...base, text: match };
		return { ...base, url_includes: match };
	}
	if (action === "load_all") {
		const interval = value["interval_ms"] ?? 1_500;
		if (
			!Number.isInteger(interval) ||
			Number(interval) < 0 ||
			Number(interval) > 60_000
		) {
			throw new Error("interval_ms must be an integer from 0 to 60000");
		}
		return {
			action,
			ref_id: refId,
			selector: requiredString(value["selector"], "selector"),
			interval_ms: Number(interval),
		};
	}
	if (action === "raw") {
		const params = value["params"] ?? {};
		if (!isRecordValue(params)) {
			throw new Error("params must be an object when provided");
		}
		return {
			action,
			ref_id: refId,
			method: requiredString(value["method"], "method"),
			params,
		};
	}
	throw new Error(`unsupported action: ${action}`);
}
