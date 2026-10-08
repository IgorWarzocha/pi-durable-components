import type { ApplyPatchToolDetails } from "./index.ts";
import type { ExecutePatchResult, FileChange } from "./patch-outcome.ts";

export interface ApplyPatchPresentationState {
	status: ApplyPatchToolDetails["status"];
	result: ExecutePatchResult;
	exact: boolean;
	failedTargets: string[];
	serializationWarnings: string[];
	/** Committed file bodies, acquired by the host only when requested. */
	detail: FileChange[] | null;
}
/** Preserve partial failure and committed metadata without retaining file bodies. */
export function createApplyPatchPresentationState(
	receipt: ApplyPatchToolDetails,
): ApplyPatchPresentationState {
	return parseState({
		status: receipt.status,
		result: receipt.result,
		exact: receipt.exact,
		failedTargets: receipt.failedTargets,
		serializationWarnings: receipt.serializationWarnings ?? [],
		detail: null,
	});
}
function parseState(value: unknown): ApplyPatchPresentationState {
	const state = record(value);
	const status = state["status"];
	if (status !== "success" && status !== "partial_failure")
		throw new TypeError("Invalid patch status");
	const receipt = record(state["result"]);
	const result: ExecutePatchResult = {
		changedFiles: strings(receipt["changedFiles"]),
		createdFiles: strings(receipt["createdFiles"]),
		deletedFiles: strings(receipt["deletedFiles"]),
		movedFiles: strings(receipt["movedFiles"]),
		fuzz: receipt["fuzz"] === 0 ? 0 : receipt["fuzz"] === 1 ? 1 : invalid(),
	};
	if (
		typeof state["exact"] !== "boolean" ||
		state["exact"] !== (result.fuzz === 0)
	)
		throw new TypeError("Invalid patch exactness");
	const failedTargets = strings(state["failedTargets"]);
	if (status === "success" && failedTargets.length)
		throw new TypeError("Successful patch has failed targets");
	let detail: FileChange[] | null = null;
	if (state["detail"] !== null) {
		if (!Array.isArray(state["detail"])) invalid();
		detail = state["detail"].map(change);
	}
	return {
		status,
		result,
		exact: state["exact"],
		failedTargets,
		serializationWarnings: strings(state["serializationWarnings"]),
		detail,
	};
}
function change(value: unknown): FileChange {
	const entry = record(value);
	const path = string(entry["path"]);
	switch (entry["kind"]) {
		case "add":
			return {
				kind: "add",
				path,
				content: string(entry["content"]),
				overwrittenContent: nullable(entry["overwrittenContent"]),
			};
		case "delete":
			return { kind: "delete", path, content: string(entry["content"]) };
		case "update":
			return {
				kind: "update",
				path,
				movePath: nullable(entry["movePath"]),
				oldContent: string(entry["oldContent"]),
				newContent: string(entry["newContent"]),
				overwrittenMoveContent: nullable(entry["overwrittenMoveContent"]),
			};
		default:
			return invalid();
	}
}
function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
	return value as Record<string, unknown>;
}
function invalid(): never {
	throw new TypeError("Invalid patch receipt");
}
function string(value: unknown): string {
	return typeof value === "string" ? value : invalid();
}
function nullable(value: unknown): string | null {
	return value === null ? null : string(value);
}
function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.map(string) : invalid();
}
export const applyPatchCapability = {
	id: "apply-patch",
	version: 1,
	parseState,
	actions: [] as readonly string[],
	streams: [] as readonly string[],
	presentations: ["summary", "detail"] as readonly string[],
};
export const applyPatchSummary = {
	id: "summary",
	select: (state: ApplyPatchPresentationState) => ({
		status: state.status,
		exact: state.exact,
		changed: state.result.changedFiles.length,
		created: state.result.createdFiles.length,
		deleted: state.result.deletedFiles.length,
		moved: state.result.movedFiles.length,
		failedTargets: state.failedTargets,
		serializationWarnings: state.serializationWarnings,
	}),
	requests: ["detail"] as readonly string[],
};
export const applyPatchDetail = {
	id: "detail",
	select: (state: ApplyPatchPresentationState) => state.detail,
	requests: [] as readonly string[],
};
