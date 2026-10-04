// Derived from Codex lib.rs and pi-codex-conversion's executor.ts. See ../NOTICE.
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { pathIdentity } from "./mutation-queue.ts";
import type { Action } from "./parser.ts";

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
export function summarize(
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
