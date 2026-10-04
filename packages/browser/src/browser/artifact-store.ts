import {
	mkdir,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { type ExecutionEnv, getOrThrow } from "@earendil-works/pi-durable/env";

/** Artifact names are generated internally, never caller-supplied paths. */
export interface BrowserArtifactStore {
	path(name: string): string;
	write(name: string, data: string | Uint8Array): Promise<void>;
	read(name: string): Promise<string>;
	remove(name: string): Promise<void>;
	entries(): Promise<readonly { name: string; mtimeMs: number }[]>;
}

export function nodeArtifactStore(directory: string): BrowserArtifactStore {
	if (!isAbsolute(directory))
		throw new Error("Native artifact directory must be absolute");
	const path = (name: string) => join(directory, name);
	return {
		path,
		async write(name, data) {
			await mkdir(directory, { recursive: true, mode: 0o700 });
			await writeFile(path(name), data, { mode: 0o600 });
		},
		async read(name) {
			return readFile(path(name), "utf8");
		},
		async remove(name) {
			await rm(path(name), { force: true });
		},
		async entries() {
			try {
				return await Promise.all(
					(await readdir(directory)).map(async (name) => ({
						name,
						mtimeMs: (await stat(path(name))).mtimeMs,
					})),
				);
			} catch (error) {
				if (
					error instanceof Error &&
					"code" in error &&
					error.code === "ENOENT"
				)
					return [];
				throw error;
			}
		},
	};
}

/** The invoking environment owns every model-visible file. No Node fallback. */
export async function environmentArtifactStore(
	env: ExecutionEnv,
	directory: string,
	context: Context,
): Promise<BrowserArtifactStore> {
	const root = getOrThrow(await env.absolutePath(directory, context));
	const path = (name: string) => `${root.replace(/[\\/]$/, "")}/${name}`;
	return {
		path,
		async write(name, data) {
			getOrThrow(await env.createDir(root, { recursive: true }, context));
			getOrThrow(await env.writeFile(path(name), data, context));
		},
		async read(name) {
			return getOrThrow(await env.readTextFile(path(name), context));
		},
		async remove(name) {
			getOrThrow(await env.remove(path(name), { force: true }, context));
		},
		async entries() {
			const result = await env.listDir(root, context);
			if (!result.ok && result.error.code === "not_found") return [];
			return getOrThrow(result).filter((entry) => entry.kind === "file");
		},
	};
}
