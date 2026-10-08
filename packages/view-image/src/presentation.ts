import type { ViewImageContent } from "./codec.ts";

export interface ViewImagePresentationState {
	path: string;
	mimeType: string;
	detail: { image: ViewImageContent; description: string | null } | null;
}
/** The host supplies the actual path and codec result from an existing invocation. */
export function createViewImagePresentationState(
	path: string,
	image: ViewImageContent,
): ViewImagePresentationState {
	return parseState({ path, mimeType: image.mimeType, detail: null });
}
function parseState(value: unknown): ViewImagePresentationState {
	const state = record(value);
	const path = string(state["path"]);
	const mimeType = string(state["mimeType"]);
	let detail: ViewImagePresentationState["detail"] = null;
	if (state["detail"] !== null) {
		const body = record(state["detail"]);
		const image = record(body["image"]);
		if (image["type"] !== "image" || image["mimeType"] !== mimeType)
			throw new TypeError("Invalid viewed image");
		detail = {
			image: { type: "image", mimeType, data: string(image["data"]) },
			description:
				body["description"] === null ? null : string(body["description"]),
		};
	}
	return { path, mimeType, detail };
}

/** Readonly receipts. The host owns binding, acquisition and ordinary tool invocation. */
export const viewImageCapability = {
	id: "view-image",
	version: 1,
	parseState,
	actions: [] as readonly string[],
	streams: [] as readonly string[],
	presentations: ["summary", "detail"] as readonly string[],
};
export const viewImageSummary = {
	id: "summary",
	select: (state: ViewImagePresentationState) => ({
		path: state.path,
		mimeType: state.mimeType,
	}),
	requests: ["detail"] as readonly string[],
};
export const viewImageDetail = {
	id: "detail",
	select: (state: ViewImagePresentationState) => state.detail,
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
