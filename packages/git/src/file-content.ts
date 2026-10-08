// Adapted from Howcode directory-git at 5c7a4e2b75c3682ce8aeb911f4dc425693507508.
// Copyright (c) 2026 Igor Warzocha. MIT licensed, see package LICENSE.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import nodePath from "node:path";
import type {
	GitFileContentIssue,
	GitFileContentsRequest,
	GitFileContentsResult,
	GitImageRequest,
	GitImageResult,
	GitReadOptions,
	GitTextFile,
} from "./contracts.ts";
import { isGitExit, resolveTree, runGit } from "./git-process.ts";

export const maxDirectoryDiffTextFileBytes = 4 * 1024 * 1024;
const imageLimit = 12 * 1024 * 1024;
const imageMimeTypes: Record<string, string> = {
	".apng": "image/apng",
	".avif": "image/avif",
	".bmp": "image/bmp",
	".gif": "image/gif",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".svg": "image/svg+xml",
	".webp": "image/webp",
};

export function normalizeDirectoryPath(path: string): string | null {
	const normalized = path.replaceAll("\\", "/");
	if (
		!normalized ||
		normalized.includes("\0") ||
		normalized.startsWith("/") ||
		/^[a-zA-Z]:\//.test(normalized)
	)
		return null;
	return normalized
		.split("/")
		.some((part) => !part || part === "." || part === "..")
		? null
		: normalized;
}

export function isContainedDirectoryPath(
	root: string,
	candidate: string,
): boolean {
	const relative = nodePath.relative(root, candidate);
	return (
		relative.length > 0 &&
		relative !== ".." &&
		!relative.startsWith(`..${nodePath.sep}`) &&
		!nodePath.isAbsolute(relative)
	);
}

export function getDirectoryTextRevision(contents: Uint8Array): string {
	return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

type BytesResult =
	| { kind: "ready"; contents: Buffer }
	| { kind: "unavailable"; issue: GitFileContentIssue };
function unavailable(
	side: "old" | "new",
	path: string,
	kind: GitFileContentIssue["kind"],
	details: { size?: number; maxBytes?: number } = {},
): Extract<BytesResult, { kind: "unavailable" }> {
	return { kind: "unavailable", issue: { side, path, kind, ...details } };
}

async function worktreeBytes(
	cwd: string,
	path: string,
	limit: number,
	signal?: AbortSignal,
): Promise<BytesResult> {
	signal?.throwIfAborted();
	let root: string;
	let resolved: string;
	try {
		root = await realpath(cwd);
		resolved = await realpath(nodePath.resolve(root, path));
	} catch (error) {
		signal?.throwIfAborted();
		return unavailable(
			"new",
			path,
			error instanceof Error &&
				"code" in error &&
				(error.code === "ENOENT" || error.code === "ENOTDIR")
				? "missing"
				: "invalid-path",
		);
	}
	if (!isContainedDirectoryPath(root, resolved))
		return unavailable("new", path, "invalid-path");
	signal?.throwIfAborted();
	let file;
	try {
		file = await open(
			resolved,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
	} catch {
		signal?.throwIfAborted();
		return unavailable("new", path, "changed");
	}
	try {
		const before = await file.stat();
		if (!before.isFile()) return unavailable("new", path, "not-file");
		if (before.size > limit)
			return unavailable("new", path, "too-large", {
				size: before.size,
				maxBytes: limit,
			});
		// A bounded read also handles a file that grows after stat, without unbounded allocation.
		const contents = Buffer.alloc(Math.min(before.size + 1, limit + 1));
		let length = 0;
		while (length < contents.length) {
			signal?.throwIfAborted();
			const result = await file.read(
				contents,
				length,
				contents.length - length,
				length,
			);
			if (result.bytesRead === 0) break;
			length += result.bytesRead;
		}
		signal?.throwIfAborted();
		const after = await file.stat();
		const currentPath = await realpath(nodePath.resolve(root, path));
		const current = await stat(currentPath);
		signal?.throwIfAborted();
		if (
			currentPath !== resolved ||
			current.dev !== before.dev ||
			current.ino !== before.ino ||
			before.dev !== after.dev ||
			before.ino !== after.ino ||
			before.size !== after.size ||
			before.mtimeMs !== after.mtimeMs ||
			before.ctimeMs !== after.ctimeMs ||
			length !== before.size
		)
			return unavailable("new", path, "changed");
		return { kind: "ready", contents: contents.subarray(0, length) };
	} catch (error) {
		signal?.throwIfAborted();
		if (error instanceof Error && error.name === "AbortError") throw error;
		return unavailable("new", path, "changed");
	} finally {
		await file.close();
	}
}

async function baselineBytes(
	cwd: string,
	tree: string,
	path: string,
	limit: number,
	signal?: AbortSignal,
): Promise<BytesResult> {
	const spec = `${tree}:${path}`;
	try {
		const type = (
			await runGit(cwd, ["cat-file", "-t", spec], {
				signal,
				timeout: 10_000,
				maxBytes: 65536,
			})
		)
			.toString("utf8")
			.trim();
		if (type !== "blob") return unavailable("old", path, "not-file");
		const size = Number(
			(
				await runGit(cwd, ["cat-file", "-s", spec], {
					signal,
					timeout: 10_000,
					maxBytes: 65536,
				})
			)
				.toString("utf8")
				.trim(),
		);
		if (!Number.isSafeInteger(size) || size < 0)
			return unavailable("old", path, "missing");
		if (size > limit)
			return unavailable("old", path, "too-large", { size, maxBytes: limit });
		const contents = await runGit(cwd, ["cat-file", "blob", spec], {
			signal,
			timeout: 10_000,
			maxBytes: limit,
		});
		return { kind: "ready", contents };
	} catch (error) {
		signal?.throwIfAborted();
		if (!isGitExit(error)) throw error;
		return unavailable("old", path, "missing");
	}
}

function decode(
	result: BytesResult,
	side: "old" | "new",
	path: string,
):
	| { kind: "ready"; file: GitTextFile }
	| Extract<BytesResult, { kind: "unavailable" }> {
	if (result.kind === "unavailable") return result;
	if (result.contents.includes(0)) return unavailable(side, path, "binary");
	try {
		return {
			kind: "ready",
			file: {
				path,
				contents: new TextDecoder("utf8", { fatal: true }).decode(
					result.contents,
				),
				revision: getDirectoryTextRevision(result.contents),
			},
		};
	} catch {
		return unavailable(side, path, "binary");
	}
}

export async function readFileContents(
	request: GitFileContentsRequest,
	options: GitReadOptions = {},
): Promise<GitFileContentsResult> {
	options.signal?.throwIfAborted();
	const newPath = normalizeDirectoryPath(request.newPath);
	if (!newPath) return unavailable("new", request.newPath, "invalid-path");
	const oldPath =
		request.oldPath === null ? null : normalizeDirectoryPath(request.oldPath);
	if (request.oldPath !== null && !oldPath)
		return unavailable("old", request.oldPath, "invalid-path");
	let oldFile: GitTextFile | null = null;
	if (oldPath) {
		let tree: string;
		try {
			tree = await resolveTree(
				request.cwd,
				request.baselineRevision,
				options.signal,
			);
		} catch (error) {
			options.signal?.throwIfAborted();
			if (!isGitExit(error)) throw error;
			return unavailable("old", oldPath, "missing");
		}
		const oldResult = decode(
			await baselineBytes(
				request.cwd,
				tree,
				oldPath,
				maxDirectoryDiffTextFileBytes,
				options.signal,
			),
			"old",
			oldPath,
		);
		if (oldResult.kind === "unavailable") return oldResult;
		oldFile = oldResult.file;
	}
	const newResult = decode(
		await worktreeBytes(
			request.cwd,
			newPath,
			maxDirectoryDiffTextFileBytes,
			options.signal,
		),
		"new",
		newPath,
	);
	return newResult.kind === "unavailable"
		? newResult
		: { kind: "ready", oldFile, newFile: newResult.file };
}

export async function readImage(
	request: GitImageRequest,
	options: GitReadOptions = {},
): Promise<GitImageResult> {
	options.signal?.throwIfAborted();
	const path = normalizeDirectoryPath(request.path);
	const mimeType = path
		? imageMimeTypes[nodePath.extname(path).toLowerCase()]
		: undefined;
	if (!path || !mimeType) return null;
	try {
		const result =
			request.side === "old"
				? await baselineBytes(
						request.cwd,
						await resolveTree(
							request.cwd,
							request.baselineRevision,
							options.signal,
						),
						path,
						imageLimit,
						options.signal,
					)
				: await worktreeBytes(request.cwd, path, imageLimit, options.signal);
		if (result.kind === "unavailable" || result.contents.length === 0)
			return null;
		return {
			side: request.side,
			mimeType,
			dataUrl: `data:${mimeType};base64,${result.contents.toString("base64")}`,
		};
	} catch (error) {
		options.signal?.throwIfAborted();
		if (!isGitExit(error)) throw error;
		return null;
	}
}
