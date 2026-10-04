// Derived from Codex lib.rs and pi-codex-conversion's executor.ts. See ../NOTICE.
import type { Context } from "@earendil-works/chord";
import { type ExecutionEnv, getOrThrow } from "@earendil-works/pi-durable/env";
import { checkAbort, PatchFileMutations } from "./file-mutations.ts";
import { pathIdentity, withMutationKeys } from "./mutation-queue.ts";
import {
	type Action,
	parsePatch,
	sourcePathsForDuplicateGuard,
} from "./parser.ts";
import {
	ExecutePatchError,
	type FileChange,
	type PatchOutcome,
	summarize,
} from "./patch-outcome.ts";
import { updateContents } from "./update.ts";

type ResolvedAction = {
	action: Action;
	path: string;
	movePath: string | undefined;
};

async function resolveActions(
	env: ExecutionEnv,
	actions: Action[],
	context: Context,
): Promise<ResolvedAction[]> {
	const resolved: ResolvedAction[] = [];
	for (const action of actions) {
		const path = getOrThrow(await env.absolutePath(action.path, context));
		resolved.push({
			action,
			path,
			movePath:
				action.type === "update" && action.movePath !== undefined
					? getOrThrow(await env.absolutePath(action.movePath, context))
					: undefined,
		});
	}
	return resolved;
}

async function applyActions(
	env: ExecutionEnv,
	actions: ResolvedAction[],
	context: Context,
): Promise<PatchOutcome> {
	const changes: FileChange[] = [];
	const files = new PatchFileMutations(env, context);
	let current: Action | undefined;
	try {
		if (actions.length === 0) throw new Error("No files were modified.");
		for (const { action, path, movePath } of actions) {
			current = action;
			checkAbort(context);
			if (action.type === "add") {
				const overwrittenContent = await files.optionalRead(path);
				await files.write(path, action.contents, true);
				changes.push({
					path,
					kind: "add",
					content: action.contents,
					overwrittenContent,
				});
			} else if (action.type === "delete") {
				await files.noteSupport(path);
				const read = await files.read(path);
				const content = read.ok ? read.value : null;
				if (content === null) files.markUncertain();
				await files.remove(path, content, "Failed to delete file");
				if (content !== null) changes.push({ path, kind: "delete", content });
			} else {
				await files.noteSupport(path);
				const read = await files.read(path);
				if (!read.ok)
					throw new Error(
						`Failed to read file to update ${path}: ${read.error.message}`,
					);
				const newContent = updateContents(read.value, path, action.chunks);
				if (movePath !== undefined) {
					const overwrittenMoveContent = await files.optionalRead(movePath);
					await files.write(movePath, newContent, true);
					const writeIndex = changes.length;
					changes.push({
						path: movePath,
						kind: "add",
						content: newContent,
						overwrittenContent: overwrittenMoveContent,
					});
					await files.remove(path, read.value, "Failed to remove original");
					changes[writeIndex] = {
						path,
						kind: "update",
						movePath,
						oldContent: read.value,
						overwrittenMoveContent,
						newContent,
					};
				} else {
					await files.write(path, newContent, false);
					changes.push({
						path,
						kind: "update",
						movePath: null,
						oldContent: read.value,
						overwrittenMoveContent: null,
						newContent,
					});
				}
			}
			checkAbort(context);
		}
		return summarize(env, changes, files.exact);
	} catch (error) {
		if (context.abortSignal?.aborted) files.markUncertain();
		throw new ExecutePatchError(
			error instanceof Error ? error.message : String(error),
			summarize(env, changes, files.exact),
			current,
		);
	}
}

/** Apply ordered file actions through the conversation environment. Never replay interrupted mutations. */
export async function executePatch(
	env: ExecutionEnv,
	input: string,
	context: Context,
): Promise<PatchOutcome> {
	checkAbort(context);
	// Preserve the pinned executor's empty-stdin failure at its native output boundary.
	if (input === "")
		throw new Error("apply_patch returned invalid structured JSON output");
	const seen = new Set<string>();
	for (const source of sourcePathsForDuplicateGuard(input) ?? []) {
		const path = getOrThrow(await env.absolutePath(source, context));
		const identity = pathIdentity(path);
		if (seen.has(identity))
			throw new Error(
				`apply_patch rejected: multiple file sections resolve to ${path}. Combine changes for each source file into one section; use multiple @@ hunks for one update`,
			);
		seen.add(identity);
	}
	let patch;
	try {
		patch = parsePatch(input);
	} catch (error) {
		throw new ExecutePatchError(
			error instanceof Error ? error.message : String(error),
			summarize(env, [], true),
			undefined,
		);
	}
	const actions = await resolveActions(env, patch.actions, context);
	const paths = actions.flatMap((action) =>
		action.movePath === undefined
			? [action.path]
			: [action.path, action.movePath],
	);
	const warnings: string[] = [];
	try {
		const outcome = await withMutationKeys(
			env,
			paths,
			context,
			() => applyActions(env, actions, context),
			warnings,
		);
		if (warnings.length) outcome.serializationWarnings = warnings;
		return outcome;
	} catch (error) {
		if (error instanceof ExecutePatchError && warnings.length)
			error.outcome.serializationWarnings = warnings;
		throw error;
	}
}
