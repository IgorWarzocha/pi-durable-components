import type { JsonValue } from "@earendil-works/chord";
import type { ImagegenOutput, SavedImage } from "./output.ts";

export interface ImagegenPresentationState {
	images: SavedImage[];
	detail: ImagegenOutput | null;
}
/** Project an existing receipt without acquiring image bytes or replaying generation. */
export function createImagegenPresentationState(
	output: ImagegenOutput,
): ImagegenPresentationState {
	return parseState({ images: output.images, detail: null });
}
function saved(value: unknown): SavedImage {
	const image = record(value);
	return {
		path: string(image["path"]),
		absolute_path: string(image["absolute_path"]),
		latest_path: string(image["latest_path"]),
		latest_absolute_path: string(image["latest_absolute_path"]),
	};
}
function parseState(value: unknown): ImagegenPresentationState {
	const state = record(value);
	if (!Array.isArray(state["images"]) || state["images"].length === 0)
		throw new TypeError("Missing generated artifacts");
	const images = state["images"].map(saved);
	let detail: ImagegenOutput | null = null;
	if (state["detail"] !== null) {
		const output = record(state["detail"]);
		if (!Array.isArray(output["images"]))
			throw new TypeError("Missing image output");
		detail = {
			path: string(output["path"]),
			latest_path: string(output["latest_path"]),
			images: output["images"].map(saved),
		};
		for (const key of ["background", "quality", "size"] as const) {
			const item = output[key];
			if (item !== undefined) detail[key] = item === null ? null : string(item);
		}
		if (output["transparent_background"] !== undefined) {
			if (typeof output["transparent_background"] !== "boolean")
				throw new TypeError("Invalid transparency");
			detail.transparent_background = output["transparent_background"];
		}
		if (output["imagegen_request_id"] !== undefined)
			detail.imagegen_request_id = string(output["imagegen_request_id"]);
		if (output["usage"] !== undefined) {
			if (!isJson(output["usage"]))
				throw new TypeError("Invalid usage metadata");
			detail.usage = output["usage"];
		}
		if (JSON.stringify(detail.images) !== JSON.stringify(images))
			throw new TypeError("Generated artifact mismatch");
	}
	return { images, detail };
}
function isJson(value: unknown): value is JsonValue {
	return (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean" ||
		(typeof value === "number" && Number.isFinite(value)) ||
		(Array.isArray(value) && value.every(isJson)) ||
		(!!value && typeof value === "object" && Object.values(value).every(isJson))
	);
}

/** Readonly receipts. The host owns binding, acquisition and ordinary tool invocation. */
export const imagegenCapability = {
	id: "imagegen",
	version: 1,
	parseState,
	actions: [] as readonly string[],
	streams: [] as readonly string[],
	presentations: ["summary", "detail"] as readonly string[],
};
export const imagegenSummary = {
	id: "summary",
	select: (state: ImagegenPresentationState) => ({
		imageCount: state.images.length,
		images: state.images,
	}),
	requests: ["detail"] as readonly string[],
};
export const imagegenDetail = {
	id: "detail",
	select: (state: ImagegenPresentationState) => state.detail,
	requests: [] as readonly string[],
};

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new TypeError("Expected a receipt object");
	return value as Record<string, unknown>;
}
function string(value: unknown): string {
	if (typeof value !== "string") throw new TypeError("Expected a string");
	return value;
}
