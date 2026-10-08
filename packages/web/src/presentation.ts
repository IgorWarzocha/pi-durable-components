import type { WebRunOutput } from "./contract.ts";

export interface WebPresentationState {
	resultCount: number;
	detail: WebRunOutput | null;
}
/** Keep opaque provider results intact in detail, not in the summary. */
export function createWebPresentationState(
	output: WebRunOutput,
): WebPresentationState {
	return parseState({
		resultCount: output.search_results?.length ?? 0,
		detail: null,
	});
}
function parseState(value: unknown): WebPresentationState {
	const state = record(value);
	let detail: WebRunOutput | null = null;
	if (state["detail"] !== null) {
		const output = record(state["detail"]);
		if (output["output_text"] !== undefined) string(output["output_text"]);
		if (
			output["search_results"] !== undefined &&
			!Array.isArray(output["search_results"])
		)
			throw new TypeError("Invalid search results");
		if (
			typeof output["output_text"] !== "string" &&
			!Array.isArray(output["search_results"])
		)
			throw new TypeError("Missing web output");
		detail = output;
	}
	const resultCount = count(state["resultCount"]);
	if (detail && (detail.search_results?.length ?? 0) !== resultCount)
		throw new TypeError("Search result count mismatch");
	return { resultCount, detail };
}

/** Readonly receipts. The host owns binding, acquisition and ordinary tool invocation. */
export const webCapability = {
	id: "web",
	version: 1,
	parseState,
	actions: [] as readonly string[],
	streams: [] as readonly string[],
	presentations: ["summary", "detail"] as readonly string[],
};
export const webSummary = {
	id: "summary",
	select: (state: WebPresentationState) => ({ resultCount: state.resultCount }),
	requests: ["detail"] as readonly string[],
};
export const webDetail = {
	id: "detail",
	select: (state: WebPresentationState) => state.detail,
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
function count(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw new TypeError("Expected a nonnegative integer");
	return value;
}
