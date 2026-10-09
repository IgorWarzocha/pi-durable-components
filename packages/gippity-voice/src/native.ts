import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { GippityAppFiles, GippityAudioHost } from "./host.ts";

/** Explicit native-process permission. No path discovery or ambient environment. */
export function createNativeGippityAudioHost(options: {
	namespace: string;
	executable: string;
	cwd: string;
	env: Record<string, string>;
}): GippityAudioHost {
	if (
		!options.namespace ||
		!isAbsolute(options.executable) ||
		!isAbsolute(options.cwd)
	)
		throw new Error(
			"Native audio requires an environment namespace and absolute executable and working directory",
		);
	return {
		namespace: options.namespace,
		launch: () =>
			spawn(options.executable, [], {
				cwd: options.cwd,
				env: options.env,
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			}),
	};
}

/** Explicit authorized native roots. Symlinks cannot escape either approved root. */
export async function createNativeGippityAppFiles(options: {
	namespace: string;
	cwd: string;
	roots: readonly string[];
	maxAssetBytes?: number;
}): Promise<GippityAppFiles> {
	if (
		!options.namespace ||
		!isAbsolute(options.cwd) ||
		!options.roots.length ||
		options.roots.some((root) => !isAbsolute(root))
	)
		throw new Error(
			"App files require namespace, absolute cwd and explicitly approved roots",
		);
	const roots = await Promise.all(options.roots.map((root) => realpath(root)));
	const limit = options.maxAssetBytes ?? 64 * 1024 * 1024;
	if (!Number.isSafeInteger(limit) || limit < 1)
		throw new Error("Asset byte limit must be positive");
	const within = (root: string, child: string) => {
		const path = relative(root, child);
		return (
			path === "" ||
			(path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
		);
	};
	return {
		namespace: options.namespace,
		async read(configuredRoot, path) {
			if (!path.startsWith("/") || path.includes("\\") || path.includes("\0"))
				throw new Error("Invalid app asset path");
			let decoded: string;
			try {
				decoded = decodeURIComponent(path);
			} catch {
				throw new Error("Invalid app asset encoding");
			}
			if (
				decoded.includes("\\") ||
				decoded.includes("\0") ||
				decoded.split("/").some((part) => part === ".." || part === ".")
			)
				throw new Error("Invalid app asset path");
			try {
				const root = await realpath(resolve(options.cwd, configuredRoot));
				if (!roots.some((approved) => within(approved, root)))
					throw new Error("Custom app root is outside approved roots");
				const file = await realpath(resolve(root, `.${decoded}`));
				if (!within(root, file) || file === root)
					throw new Error("App asset escapes its configured root");
				const handle = await open(
					file,
					constants.O_RDONLY | constants.O_NOFOLLOW,
				);
				try {
					const stat = await handle.stat();
					if (!stat.isFile()) return undefined;
					if (stat.size > limit)
						throw new Error("App asset exceeds the authorized byte limit");
					const chunks: Buffer[] = [];
					let size = 0;
					for await (const chunk of handle.createReadStream({
						autoClose: false,
					})) {
						size += chunk.byteLength;
						if (size > limit)
							throw new Error("App asset exceeds the authorized byte limit");
						chunks.push(Buffer.from(chunk));
					}
					return {
						contentType:
							CONTENT_TYPES[extname(file).toLowerCase()] ??
							"application/octet-stream",
						body: Buffer.concat(chunks),
					};
				} finally {
					await handle.close();
				}
			} catch (error) {
				if (
					error &&
					typeof error === "object" &&
					"code" in error &&
					(error.code === "ENOENT" || error.code === "ENOTDIR")
				)
					return undefined;
				throw error;
			}
		},
	};
}

const CONTENT_TYPES: Record<string, string> = {
	".css": "text/css; charset=utf-8",
	".gif": "image/gif",
	".html": "text/html; charset=utf-8",
	".ico": "image/x-icon",
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".png": "image/png",
	".svg": "image/svg+xml",
	".txt": "text/plain; charset=utf-8",
	".wasm": "application/wasm",
	".webmanifest": "application/manifest+json; charset=utf-8",
	".webp": "image/webp",
	".woff": "font/woff",
	".woff2": "font/woff2",
};
