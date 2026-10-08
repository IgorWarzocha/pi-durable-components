// Adapted from Howcode directory-git at 5c7a4e2b75c3682ce8aeb911f4dc425693507508.
// Copyright (c) 2026 Igor Warzocha. MIT licensed, see package LICENSE.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	GitDiffOptions,
	GitDiffRequest,
	GitDiffStats,
	GitReader,
	GitReadOptions,
} from "./contracts.ts";
import { readFileContents, readImage } from "./file-content.ts";
import { isGitExit, resolveTree, runGit } from "./git-process.ts";

export {
	getDirectoryTextRevision,
	isContainedDirectoryPath,
	maxDirectoryDiffTextFileBytes,
	normalizeDirectoryPath,
} from "./file-content.ts";
export const EMPTY_TREE_OID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

async function headTree(
	cwd: string,
	signal?: AbortSignal,
): Promise<string | null> {
	try {
		return await resolveTree(cwd, "HEAD", signal);
	} catch (error) {
		signal?.throwIfAborted();
		if (!isGitExit(error)) throw error;
		return null;
	}
}

async function withSnapshot<T>(
	cwd: string,
	includeUntracked: boolean,
	options: GitReadOptions,
	callback: (index: string, baseline: string) => Promise<T>,
): Promise<T> {
	options.signal?.throwIfAborted();
	const directory = await mkdtemp(join(tmpdir(), "pi-durable-git-index-"));
	const index = join(directory, "index");
	try {
		const head = await headTree(cwd, options.signal);
		await runGit(cwd, ["read-tree", head ?? "--empty"], {
			index,
			signal: options.signal,
			maxBytes: 1024 * 1024,
		});
		await runGit(cwd, ["add", includeUntracked ? "-A" : "-u", "--", "."], {
			index,
			signal: options.signal,
			maxBytes: 8 * 1024 * 1024,
		});
		// Unique indexes do not share locks. Git installs content-addressed objects atomically.
		return await callback(index, head ?? EMPTY_TREE_OID);
	} finally {
		// Every Git command above settles its child before rejecting.
		await rm(directory, { recursive: true, force: true });
	}
}

function parseNumStat(output: string): GitDiffStats {
	let fileCount = 0;
	let insertions = 0;
	let deletions = 0;
	// NUL framing handles tabs/newlines in paths and the extra rename path pair.
	const fields = output.split("\0");
	for (let i = 0; i < fields.length; i++) {
		const record = fields[i];
		if (!record) continue;
		const first = record.indexOf("\t");
		const second = record.indexOf("\t", first + 1);
		if (first < 0 || second < 0) throw new Error("Invalid Git numstat output.");
		fileCount++;
		const added = Number.parseInt(record.slice(0, first), 10);
		const removed = Number.parseInt(record.slice(first + 1, second), 10);
		if (!Number.isNaN(added)) insertions += added;
		if (!Number.isNaN(removed)) deletions += removed;
		if (record.slice(second + 1) === "") i += 2;
	}
	return { fileCount, insertions, deletions };
}

async function snapshotStats(
	cwd: string,
	index: string,
	baseline: string,
	signal?: AbortSignal,
): Promise<GitDiffStats> {
	try {
		return parseNumStat(
			(
				await runGit(
					cwd,
					[
						"diff",
						"--cached",
						"--numstat",
						"-z",
						"--find-renames",
						"--no-ext-diff",
						"--no-textconv",
						baseline,
						"--",
					],
					{ index, signal, maxBytes: 4 * 1024 * 1024 },
				)
			).toString("utf8"),
		);
	} catch (error) {
		signal?.throwIfAborted();
		// Source returns zero counts for Git numstat failures, never cancellation/limits.
		if (!isGitExit(error)) throw error;
		return { fileCount: 0, insertions: 0, deletions: 0 };
	}
}

async function baselineFor(
	request: GitDiffRequest,
	fallback: string,
	signal?: AbortSignal,
): Promise<string> {
	return request.baseRevision?.trim()
		? resolveTree(request.cwd, request.baseRevision, signal)
		: fallback;
}

/** Explicitly grants native process and filesystem authority to the caller. */
export function createNativeGitReader(): GitReader {
	const reader: GitReader = {
		async isRepository(cwd, options = {}) {
			try {
				return (
					(
						await runGit(cwd, ["rev-parse", "--is-inside-work-tree"], {
							signal: options.signal,
							timeout: 3000,
							maxBytes: 65536,
						})
					)
						.toString("utf8")
						.trim() === "true"
				);
			} catch (error) {
				options.signal?.throwIfAborted();
				const unavailableNativePath =
					error instanceof Error &&
					"code" in error &&
					(error.code === "ENOENT" || error.code === "ENOTDIR");
				if (!isGitExit(error) && !unavailableNativePath) throw error;
				return false;
			}
		},
		async diff(request, options: GitDiffOptions = {}) {
			return withSnapshot(
				request.cwd,
				request.includeUntracked === true,
				options,
				async (index, fallback) => {
					const baseline = await baselineFor(request, fallback, options.signal);
					// Sequential children keep temporary-index cleanup owned even if a chunk callback fails.
					const patch = await runGit(
						request.cwd,
						[
							"diff",
							"--cached",
							"--unified=1",
							"--no-color",
							"--no-ext-diff",
							"--no-textconv",
							"--find-renames",
							"--src-prefix=a/",
							"--dst-prefix=b/",
							baseline,
							"--",
						],
						{ index, signal: options.signal, onChunk: options.onChunk },
					);
					const stats = await snapshotStats(
						request.cwd,
						index,
						baseline,
						options.signal,
					);
					return { ...stats, diff: patch.toString("utf8").trim() };
				},
			);
		},
		async stats(request, options = {}) {
			return withSnapshot(
				request.cwd,
				request.includeUntracked === true,
				options,
				async (index, fallback) =>
					snapshotStats(
						request.cwd,
						index,
						await baselineFor(request, fallback, options.signal),
						options.signal,
					),
			);
		},
		async readFileContents(request, options = {}) {
			if (!(await reader.isRepository(request.cwd, options)))
				return {
					kind: "unavailable",
					issue: { side: "new", path: request.newPath, kind: "missing" },
				};
			return readFileContents(request, options);
		},
		async readImage(request, options = {}) {
			if (!(await reader.isRepository(request.cwd, options))) return null;
			return readImage(request, options);
		},
		async captureWorktreeTree(cwd, options = {}) {
			return withSnapshot(cwd, true, options, async (index) =>
				(
					await runGit(cwd, ["write-tree"], {
						index,
						signal: options.signal,
						maxBytes: 128 * 1024,
					})
				)
					.toString("utf8")
					.trim(),
			);
		},
	};
	return reader;
}
