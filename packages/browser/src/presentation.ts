import type { BrowserRuntime } from "./browser/runtime.ts";

export type BrowserResult = Awaited<ReturnType<BrowserRuntime["execute"]>>;
export interface BrowserPresentationState {
	host: string | null;
	operationCount: number;
	screenshots: string[];
	continuations: Array<{ handle: string; nextOffset: number }>;
	detail: BrowserResult | null;
}
/** Project actual completed output. A thrown batch failure is not a success receipt. */
export function createBrowserPresentationState(
	output: BrowserResult,
): BrowserPresentationState {
	const results = Array.isArray(output["results"])
		? output["results"].map(record)
		: [output];
	const continuations = results.flatMap((result) => {
		const handle = result["result_handle"] ?? result["handle"];
		const offset = result["next_offset"];
		return handle === undefined || offset === undefined
			? []
			: [{ handle: string(handle), nextOffset: count(offset) }];
	});
	const screenshots = results.flatMap((result) =>
		result["file"] === undefined ? [] : [string(result["file"])],
	);
	return parseState({
		host: output["host"] ?? null,
		operationCount: results.length,
		screenshots,
		continuations,
		detail: null,
	});
}
function parseState(value: unknown): BrowserPresentationState {
	const state = record(value);
	const host = state["host"] === null ? null : string(state["host"]);
	const operationCount = count(state["operationCount"]);
	if (!Array.isArray(state["screenshots"]))
		throw new TypeError("Missing screenshot metadata");
	const screenshots = state["screenshots"].map(string);
	if (!Array.isArray(state["continuations"]))
		throw new TypeError("Missing continuations");
	const continuations = state["continuations"].map((value: unknown) => {
		const cursor = record(value);
		return {
			handle: string(cursor["handle"]),
			nextOffset: count(cursor["nextOffset"]),
		};
	});
	const detail = state["detail"] === null ? null : record(state["detail"]);
	if (
		detail &&
		(Array.isArray(detail["results"]) ? detail["results"].length : 1) !==
			operationCount
	)
		throw new TypeError("Browser operation count mismatch");
	return { host, operationCount, screenshots, continuations, detail };
}

/** Readonly receipts. The host owns binding, acquisition and ordinary tool invocation. */
export const browserCapability = {
	id: "browser",
	version: 1,
	parseState,
	actions: [] as readonly string[],
	streams: [] as readonly string[],
	presentations: ["summary", "detail"] as readonly string[],
};
export const browserSummary = {
	id: "summary",
	select: (state: BrowserPresentationState) => ({
		host: state.host,
		operationCount: state.operationCount,
		screenshots: state.screenshots,
		continuations: state.continuations,
	}),
	requests: ["detail"] as readonly string[],
};
export const browserDetail = {
	id: "detail",
	select: (state: BrowserPresentationState) => state.detail,
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
