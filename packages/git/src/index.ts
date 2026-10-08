import { defineTool } from "@earendil-works/pi-durable";
import { type ExecutionEnv, getOrThrow } from "@earendil-works/pi-durable/env";
import { Type } from "typebox";
import type { GitReader } from "./contracts.ts";

export * from "./contracts.ts";
export {
	createNativeGitReader,
	EMPTY_TREE_OID,
	getDirectoryTextRevision,
	isContainedDirectoryPath,
	maxDirectoryDiffTextFileBytes,
	normalizeDirectoryPath,
} from "./native.ts";

const parameters = Type.Object({
	cwd: Type.Optional(
		Type.String({
			description:
				"Repository directory in the conversation execution environment",
		}),
	),
	baseRevision: Type.Optional(
		Type.String({
			description: "Baseline revision, default HEAD or empty tree",
		}),
	),
	includeUntracked: Type.Optional(Type.Boolean()),
});

export interface GitToolOptions {
	/** Return only a reader authorized for this exact execution namespace. No host fallback. */
	readerForEnvironment(environment: ExecutionEnv): GitReader | undefined;
}

/** Ordinary registry tool. Code and Notebook discover it without a component bridge. */
export function createGitDiffTool(options: GitToolOptions) {
	return defineTool({
		name: "git_diff",
		description:
			"Read worktree changes against a Git baseline, without changing the user index or worktree",
		parameters,
		replay: "safe",
		async execute(args, api, context) {
			context.abortSignal?.throwIfAborted();
			if (!api.env)
				throw new Error("git_diff requires an execution environment");
			const reader = options.readerForEnvironment(api.env);
			if (!reader)
				throw new Error(
					"git_diff has no Git capability for this execution environment",
				);
			const cwd = getOrThrow(
				await api.env.absolutePath(args.cwd ?? ".", context),
			);
			const result = await reader.diff(
				{
					cwd,
					...(args.baseRevision === undefined
						? {}
						: { baseRevision: args.baseRevision }),
					...(args.includeUntracked === undefined
						? {}
						: { includeUntracked: args.includeUntracked }),
				},
				context.abortSignal ? { signal: context.abortSignal } : {},
			);
			return {
				content: [{ type: "text", text: result.diff || "No changes." }],
				details: { ...result },
			};
		},
	});
}
