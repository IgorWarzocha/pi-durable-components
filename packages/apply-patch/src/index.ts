import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import {
	ExecutePatchError,
	type ExecutePatchResult,
	executePatch,
	type FileChange,
} from "./executor.ts";

export type {
	ExecutePatchResult,
	FileChange,
	PatchOutcome,
} from "./executor.ts";
export { ExecutePatchError, executePatch } from "./executor.ts";

const parameters = Type.Object({
	input: Type.String({
		description:
			"*** Begin Patch / *** End Patch; Add/Update/Delete File sections. *** Move to: path immediately follows its Update File header; requires a nonempty @@ hunk (one unchanged context line for pure moves). Hunks follow file order; indentation is literal",
	}),
});
export type ApplyPatchToolDetails = {
	status: "success" | "partial_failure";
	result: ExecutePatchResult;
	changes: FileChange[];
	exact: boolean;
	failedTargets: string[];
	serializationWarnings?: string[];
};

function prepareArguments(args: unknown): { input: string } {
	if (args && typeof args === "object") {
		if ("input" in args && typeof args.input === "string")
			return { input: args.input };
		if ("patchText" in args && typeof args.patchText === "string")
			return { input: args.patchText };
		if ("patch" in args && typeof args.patch === "string")
			return { input: args.patch };
	}
	throw new Error("apply_patch requires a string 'input' parameter");
}
function counts(result: ExecutePatchResult): string {
	return `changed ${result.changedFiles.length} file${result.changedFiles.length === 1 ? "" : "s"}, created ${result.createdFiles.length}, deleted ${result.deletedFiles.length}, moved ${result.movedFiles.length}`;
}
function failedTargets(error: ExecutePatchError): string[] {
	const action = error.action;
	return action === undefined
		? []
		: [
				action.type === "update" && action.movePath !== undefined
					? `${action.path} -> ${action.movePath}`
					: action.path,
			];
}
function failureMessage(error: ExecutePatchError, partial: boolean): string {
	const targets = failedTargets(error);
	const prefix = partial
		? `apply_patch partially failed after ${counts(error.result)}`
		: "apply_patch failed";
	const preview = error.message.startsWith("Failed to find expected lines")
		? error.message
				.split("\n")
				.slice(1)
				.find((line) => line.trim() !== "")
				?.trim()
		: undefined;
	const cause =
		preview === undefined
			? error.message
			: `expected context not found\nExpected near: ${preview}`;
	let message = `${prefix}${targets.length ? ` while patching ${targets.join(", ")}` : ""}: ${cause}`;
	const action = error.action;
	const paths =
		action === undefined
			? []
			: [
					...new Set([
						action.path,
						...(action.type === "update" && action.movePath !== undefined
							? [action.movePath]
							: []),
					]),
				];
	if (partial) {
		if (paths.length)
			message += `\nFailed file${paths.length === 1 ? "" : "s"}: ${paths.join(", ")}\nRecovery: MUST read ${paths.join(", ")} before retrying`;
		if (error.result.changedFiles.some((path) => !paths.includes(path))) {
			message +=
				"\nEarlier file actions in this patch were already applied\nRecovery: MUST NOT reread other files from this patch unless a specific dependency requires it";
		}
	} else if (preview !== undefined) {
		message += `\nRecovery: MUST read ${targets.join(", ") || "the failed file"} and retry only the failed edit against current contents`;
	}
	return message;
}

/** A normal Durable registration, automatically discoverable by Code and Notebook. */
export function createApplyPatchTool() {
	// Match the pinned tool's opt-in strict function sampling, not a custom grammar tool.
	const constrainedSampling =
		process.env["PI_EXPERIMENTAL"] === "1"
			? ({ type: "json_schema", strict: "prefer" } as const)
			: undefined;
	return defineTool<typeof parameters, ApplyPatchToolDetails>({
		name: "apply_patch",
		description: "Patch files",
		parameters,
		...(constrainedSampling === undefined ? {} : { constrainedSampling }),
		executionMode: "sequential",
		replay: "unsafe",
		prepareArguments,
		async execute(args, api, context) {
			if (!api.env)
				throw new Error("apply_patch requires an execution environment");
			try {
				const outcome = await executePatch(api.env, args.input, context);
				const result = outcome.result;
				return {
					content: [
						{
							type: "text",
							text: `Applied patch successfully\nChanged files: ${result.changedFiles.length}\nCreated files: ${result.createdFiles.length}\nDeleted files: ${result.deletedFiles.length}\nMoved files: ${result.movedFiles.length}\nFuzz: ${result.fuzz}`,
						},
					],
					details: { status: "success", ...outcome, failedTargets: [] },
					diagnostics: (outcome.serializationWarnings ?? []).map((message) => ({
						severity: "warn",
						message,
					})),
				};
			} catch (error) {
				if (!(error instanceof ExecutePatchError)) throw error;
				const partial = error.hasPartialSuccess();
				const message = failureMessage(error, partial);
				for (const warning of error.outcome.serializationWarnings ?? [])
					api.diagnostic({ severity: "warn", message: warning });
				if (!partial) throw new Error(message, { cause: error });
				return {
					content: [{ type: "text", text: message }],
					isError: true,
					details: {
						status: "partial_failure",
						...error.outcome,
						failedTargets: failedTargets(error),
					},
				};
			}
		},
	});
}

export const ApplyPatch = defineExtension({
	name: "apply-patch",
	tools: [createApplyPatchTool()],
});
