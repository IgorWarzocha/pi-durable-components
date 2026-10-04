// Derived from Codex lib.rs and pi-codex-conversion's executor.ts. See ../NOTICE.
import type { Context } from "@earendil-works/chord";
import {
	type ExecutionEnv,
	err,
	FileError,
	getOrThrow,
	ok,
	type Result,
} from "@earendil-works/pi-durable/env";
import { pathIdentity, withMutationKeys } from "./mutation-queue.ts";
import {
	type Action,
	parsePatch,
	sourcePathsForDuplicateGuard,
} from "./parser.ts";
import { updateContents } from "./update.ts";

export type ExecutePatchResult = {
	changedFiles: string[];
	createdFiles: string[];
	deletedFiles: string[];
	movedFiles: string[];
	fuzz: number;
};
export type FileChange =
	| {
			path: string;
			kind: "add";
			content: string;
			overwrittenContent: string | null;
	  }
	| { path: string; kind: "delete"; content: string }
	| {
			path: string;
			kind: "update";
			movePath: string | null;
			oldContent: string;
			overwrittenMoveContent: string | null;
			newContent: string;
	  };
export type PatchOutcome = {
	result: ExecutePatchResult;
	changes: FileChange[];
	exact: boolean;
	serializationWarnings?: string[];
};
export class ExecutePatchError extends Error {
	readonly outcome: PatchOutcome;
	readonly action: Action | undefined;
	constructor(
		message: string,
		outcome: PatchOutcome,
		action: Action | undefined,
	) {
		super(message);
		this.name = "ExecutePatchError";
		this.outcome = outcome;
		this.action = action;
	}
	get result(): ExecutePatchResult {
		return this.outcome.result;
	}
	hasPartialSuccess(): boolean {
		return this.result.changedFiles.length > 0 || this.result.fuzz > 0;
	}
}
type ResolvedAction = {
	action: Action;
	path: string;
	movePath: string | undefined;
};

function unique(values: string[], value: string): void {
	if (!values.includes(value)) values.push(value);
}
function displayPath(env: ExecutionEnv, path: string): string {
	const separator = /^[A-Za-z]:[\\/]|^\\\\/.test(env.cwd) ? "\\" : "/";
	const prefix = env.cwd.replace(/[/\\]$/, "") + separator;
	return pathIdentity(path).startsWith(pathIdentity(prefix))
		? path.slice(prefix.length)
		: path;
}
function summarize(
	env: ExecutionEnv,
	changes: FileChange[],
	exact: boolean,
): PatchOutcome {
	const result: ExecutePatchResult = {
		changedFiles: [],
		createdFiles: [],
		deletedFiles: [],
		movedFiles: [],
		fuzz: exact ? 0 : 1,
	};
	const displayed = changes.map((change) => ({
		...change,
		path: displayPath(env, change.path),
		...(change.kind === "update" && change.movePath !== null
			? { movePath: displayPath(env, change.movePath) }
			: {}),
	}));
	for (const change of displayed) {
		unique(result.changedFiles, change.path);
		if (change.kind === "add" && change.overwrittenContent === null)
			unique(result.createdFiles, change.path);
		if (change.kind === "delete") unique(result.deletedFiles, change.path);
		if (change.kind === "update" && change.movePath !== null) {
			unique(result.changedFiles, change.movePath);
			unique(result.deletedFiles, change.path);
			if (change.overwrittenMoveContent === null)
				unique(result.createdFiles, change.movePath);
			unique(result.movedFiles, `${change.path} -> ${change.movePath}`);
		}
	}
	return { result, changes: displayed, exact };
}
function checkAbort(context: Context): void {
	if (context.abortSignal?.aborted)
		throw new Error(
			"apply_patch aborted. An interrupted mutation may have taken effect; read its target before retrying",
		);
}

async function readText(
	env: ExecutionEnv,
	path: string,
	context: Context,
): Promise<Result<string, FileError>> {
	const bytes = await env.readBinaryFile(path, context);
	if (!bytes.ok) return bytes;
	try {
		return ok(
			new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
				bytes.value,
			),
		);
	} catch {
		return err(
			new FileError("invalid", "stream did not contain valid UTF-8", path),
		);
	}
}

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
	let exact = true;
	let current: Action | undefined;
	async function noteSupport(path: string): Promise<void> {
		const info = await env.fileInfo(path, context);
		// The native metadata adapter follows symlinks, while Durable fileInfo uses lstat.
		// A dangling link reports NotFound there, not an existing unsupported delta target.
		if (info.ok && info.value.kind === "symlink") {
			const target = await env.canonicalPath(path, context);
			if (!target.ok && target.error.code === "not_found") return;
		}
		if (info.ok ? info.value.kind !== "file" : info.error.code !== "not_found")
			exact = false;
	}
	async function optionalRead(path: string): Promise<string | null> {
		await noteSupport(path);
		const read = await readText(env, path, context);
		if (read.ok) return read.value;
		if (read.error.code !== "not_found") exact = false;
		return null;
	}
	async function write(
		path: string,
		contents: string,
		allowParents: boolean,
	): Promise<void> {
		checkAbort(context);
		let result = await env.writeFile(path, contents, context);
		if (
			!result.ok &&
			result.error.code === "not_found" &&
			allowParents &&
			!context.abortSignal?.aborted
		) {
			// Only retry the native engine's explicit missing-parent case, not interrupted writes.
			const parent = getOrThrow(await env.joinPath([path, ".."], context));
			const created = await env.createDir(parent, { recursive: true }, context);
			if (!created.ok) {
				exact = false;
				throw new Error(
					`Failed to create parent directories for ${path}: ${created.error.message}`,
				);
			}
			checkAbort(context);
			result = await env.writeFile(path, contents, context);
		}
		if (!result.ok) {
			exact = false;
			throw new Error(`Failed to write file ${path}: ${result.error.message}`);
		}
		// Record committed writes before checking cancellation again.
	}
	async function remove(
		path: string,
		oldContent: string | null,
		label: string,
	): Promise<void> {
		checkAbort(context);
		let info = await env.fileInfo(path, context);
		if (info.ok && info.value.kind === "symlink") {
			const canonical = await env.canonicalPath(path, context);
			if (!canonical.ok)
				throw new Error(`${label} ${path}: ${canonical.error.message}`);
			info = await env.fileInfo(canonical.value, context);
		}
		if (!info.ok) throw new Error(`${label} ${path}: ${info.error.message}`);
		if (info.value.kind === "directory")
			throw new Error(`${label} ${path}: path is a directory`);
		checkAbort(context);
		const removed = await env.remove(
			path,
			{ recursive: false, force: false },
			context,
		);
		if (!removed.ok) {
			const after = await readText(env, path, context);
			exact =
				exact && oldContent !== null && after.ok && after.value === oldContent;
			throw new Error(`${label} ${path}: ${removed.error.message}`);
		}
	}
	try {
		if (actions.length === 0) throw new Error("No files were modified.");
		for (const { action, path, movePath } of actions) {
			current = action;
			checkAbort(context);
			if (action.type === "add") {
				const overwrittenContent = await optionalRead(path);
				await write(path, action.contents, true);
				changes.push({
					path,
					kind: "add",
					content: action.contents,
					overwrittenContent,
				});
			} else if (action.type === "delete") {
				await noteSupport(path);
				const read = await readText(env, path, context);
				const content = read.ok ? read.value : null;
				if (content === null) exact = false;
				await remove(path, content, "Failed to delete file");
				if (content !== null) changes.push({ path, kind: "delete", content });
			} else {
				await noteSupport(path);
				const read = await readText(env, path, context);
				if (!read.ok)
					throw new Error(
						`Failed to read file to update ${path}: ${read.error.message}`,
					);
				const newContent = updateContents(read.value, path, action.chunks);
				if (movePath !== undefined) {
					const overwrittenMoveContent = await optionalRead(movePath);
					await write(movePath, newContent, true);
					const writeIndex = changes.length;
					changes.push({
						path: movePath,
						kind: "add",
						content: newContent,
						overwrittenContent: overwrittenMoveContent,
					});
					await remove(path, read.value, "Failed to remove original");
					changes[writeIndex] = {
						path,
						kind: "update",
						movePath,
						oldContent: read.value,
						overwrittenMoveContent,
						newContent,
					};
				} else {
					await write(path, newContent, false);
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
		return summarize(env, changes, exact);
	} catch (error) {
		if (context.abortSignal?.aborted) exact = false;
		throw new ExecutePatchError(
			error instanceof Error ? error.message : String(error),
			summarize(env, changes, exact),
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
