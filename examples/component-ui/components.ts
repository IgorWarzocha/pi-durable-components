import type {
	JsonValue,
	UiCapability,
	UiPresentation,
} from "@howaboua/pi-durable-ui";

function object(value: JsonValue): { readonly [key: string]: JsonValue } {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Expected state object");
	return value as { readonly [key: string]: JsonValue };
}
function string(value: JsonValue | undefined): string {
	if (typeof value !== "string") throw new Error("Expected string");
	return value;
}

interface Anchor {
	path: string;
	side: string;
	line: number;
	text: string;
}
export interface ReviewState {
	revision: string;
	diff: string;
	anchors: Anchor[];
	comments: JsonValue[];
}
export const reviewCapability: UiCapability<ReviewState> = {
	id: "review",
	version: 1,
	actions: ["refresh", "comment"],
	streams: [],
	parseState(value) {
		const state = object(value);
		const list = state["anchors"];
		const comments = state["comments"];
		if (!Array.isArray(list) || !Array.isArray(comments))
			throw new Error("Invalid review state");
		return {
			revision: string(state["revision"]),
			diff: string(state["diff"]),
			comments,
			anchors: list.map((value) => {
				const anchor = object(value);
				const line = anchor["line"];
				const side = string(anchor["side"]);
				if (
					typeof line !== "number" ||
					!Number.isSafeInteger(line) ||
					line < 1 ||
					!["old", "new"].includes(side)
				)
					throw new Error("Invalid anchor");
				return {
					path: string(anchor["path"]),
					side,
					line,
					text: string(anchor["text"]),
				};
			}),
		};
	},
	presentations: ["summary", "detail"],
};

export interface SummaryModel {
	title: string;
	description: string;
}
export const reviewSummary: UiPresentation<ReviewState, SummaryModel> = {
	id: "summary",
	select: (state) => ({
		title: "Git review",
		description: `${state.anchors.length} commentable lines · ${state.comments.length} saved comments`,
	}),
	requests: ["detail"],
};
export const reviewDetail: UiPresentation<ReviewState, ReviewState> = {
	id: "detail",
	select: (state) => state,
	requests: [],
};
