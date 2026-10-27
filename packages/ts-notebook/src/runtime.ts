// Adapted from howaboua-pi-stuff at 84bd5bce, MIT. See ../NOTICE.
import { readFile } from "node:fs/promises";
import { createRequire, findPackageJSON } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { cacheExactNpmImport } from "./npm-cache.ts";

export interface TsRuntime {
	api: typeof import("tsrs/async");
	ast: typeof import("tsrs/ast");
	fs: typeof import("tsrs/fs");
	typeRoots: string[];
	launcher: string;
}

/** Prefer an exact installed payload, then reuse or provision the owned runtime cache. */
async function runtimePackage(
	name: string,
	version: string,
	stateDirectory: string,
	signal?: AbortSignal,
): Promise<{ resolve: NodeJS.RequireResolve; manifest: string }> {
	signal?.throwIfAborted();
	try {
		const manifest = findPackageJSON(name, import.meta.url);
		if (manifest) {
			const value: unknown = JSON.parse(await readFile(manifest, "utf8"));
			if (
				value &&
				typeof value === "object" &&
				"name" in value &&
				value.name === name &&
				"version" in value &&
				value.version === version
			)
				return { resolve: createRequire(manifest).resolve, manifest };
		}
	} catch (error) {
		if (
			!(
				error instanceof Error &&
				"code" in error &&
				(error.code === "ERR_MODULE_NOT_FOUND" || error.code === "ENOENT")
			)
		)
			throw error;
	}
	try {
		const location = await cacheExactNpmImport(
			`npm:${name}@${version}`,
			join(stateDirectory, "ts-runtimes"),
			signal,
			true,
		);
		const manifest = join(location.cwd, "node_modules", name, "package.json");
		return { resolve: createRequire(manifest).resolve, manifest };
	} catch (cause) {
		signal?.throwIfAborted();
		throw new Error(
			"TS runtime installation failed. Check npm and registry access, then retry; other execution modes remain available.",
			{ cause },
		);
	}
}

export async function loadTsRuntime(
	stateDirectory: string,
	signal?: AbortSignal,
): Promise<TsRuntime> {
	signal?.throwIfAborted();
	const compiler = await runtimePackage(
		"tsrs",
		"0.20.0-ts7.1.0-beta",
		stateDirectory,
		signal,
	);
	const node = await runtimePackage(
		"@types/node",
		"26.6.5",
		stateDirectory,
		signal,
	);
	const [api, ast, fs]: [TsRuntime["api"], TsRuntime["ast"], TsRuntime["fs"]] =
		await Promise.all([
			import(pathToFileURL(compiler.resolve("tsrs/async")).href),
			import(pathToFileURL(compiler.resolve("tsrs/ast")).href),
			import(pathToFileURL(compiler.resolve("tsrs/fs")).href),
		]);
	signal?.throwIfAborted();
	return {
		api,
		ast,
		fs,
		typeRoots: [dirname(dirname(node.resolve("@types/node/package.json")))],
		launcher: join(dirname(compiler.manifest), "bin", "tsrs"),
	};
}
