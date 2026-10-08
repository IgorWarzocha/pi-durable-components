/** Browser-safe requests and results. The host authorizes cwd and baseline policy. */
export interface GitDiffRequest {
	cwd: string;
	baseRevision?: string;
	includeUntracked?: boolean;
}
export interface GitDiffStats {
	fileCount: number;
	insertions: number;
	deletions: number;
}
export interface GitDiffResult extends GitDiffStats {
	diff: string;
}
/** Validate the JSON RPC boundary without importing a server or UI runtime. */
export function parseGitDiffResult(value: unknown): GitDiffResult {
	if (
		!value ||
		typeof value !== "object" ||
		!("diff" in value) ||
		typeof value.diff !== "string" ||
		!("fileCount" in value) ||
		!("insertions" in value) ||
		!("deletions" in value)
	) {
		throw new TypeError("Invalid Git diff result");
	}
	const count = (input: unknown): number => {
		if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0)
			throw new TypeError("Invalid Git diff count");
		return input;
	};
	return {
		diff: value.diff,
		fileCount: count(value.fileCount),
		insertions: count(value.insertions),
		deletions: count(value.deletions),
	};
}
export interface GitFileContentsRequest {
	cwd: string;
	baselineRevision: string;
	oldPath: string | null;
	newPath: string;
}
export interface GitTextFile {
	path: string;
	contents: string;
	revision: string;
}
export interface GitFileContentIssue {
	side: "old" | "new";
	path: string;
	kind:
		| "invalid-path"
		| "missing"
		| "not-file"
		| "too-large"
		| "binary"
		| "changed";
	size?: number;
	maxBytes?: number;
}
export type GitFileContentsResult =
	| { kind: "ready"; oldFile: GitTextFile | null; newFile: GitTextFile }
	| { kind: "unavailable"; issue: GitFileContentIssue };
export interface GitImageRequest {
	cwd: string;
	baselineRevision: string;
	path: string;
	side: "old" | "new";
}
export type GitImageResult = {
	side: "old" | "new";
	mimeType: string;
	dataUrl: string;
} | null;
export interface GitReadOptions {
	signal?: AbortSignal;
}
export interface GitDiffOptions extends GitReadOptions {
	/** Ordered raw patch chunks. The completed result is authoritative. */
	onChunk?: (chunk: string) => void;
}
export interface GitReader {
	isRepository(cwd: string, options?: GitReadOptions): Promise<boolean>;
	diff(
		request: GitDiffRequest,
		options?: GitDiffOptions,
	): Promise<GitDiffResult>;
	stats(
		request: GitDiffRequest,
		options?: GitReadOptions,
	): Promise<GitDiffStats>;
	readFileContents(
		request: GitFileContentsRequest,
		options?: GitReadOptions,
	): Promise<GitFileContentsResult>;
	readImage(
		request: GitImageRequest,
		options?: GitReadOptions,
	): Promise<GitImageResult>;
	/** Writes unreachable Git objects, never the user's index or worktree. */
	captureWorktreeTree(cwd: string, options?: GitReadOptions): Promise<string>;
}
