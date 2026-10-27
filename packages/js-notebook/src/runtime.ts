// Adapted from Pi Stuff 84bd5bce runtime-package.ts and js-mode/runtime.ts, MIT. See ../NOTICE.
import { readFile } from "node:fs/promises";
import { createRequire, findPackageJSON } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { CodemodeWasmModule } from "@earendil-works/pi-codemode";
import { cacheRuntimePackage } from "./runtime-cache.ts";

export interface JsRuntime {
	wasm: CodemodeWasmModule;
	moduleUrl: string;
}

export class RuntimeInstallError extends Error {}

/** Reuse exact installed packages before provisioning the explicit native state directory. */
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
		const manifest = await cacheRuntimePackage(
			name,
			version,
			join(stateDirectory, "js-runtimes"),
			signal,
		);
		return { resolve: createRequire(manifest).resolve, manifest };
	} catch (cause) {
		signal?.throwIfAborted();
		throw new RuntimeInstallError(
			"JS Notebook runtime installation failed. Check npm and registry access, then retry; other execution modes remain available.",
			{ cause },
		);
	}
}

export async function loadJsRuntime(
	stateDirectory: string,
	signal?: AbortSignal,
): Promise<JsRuntime> {
	signal?.throwIfAborted();
	const installed = await runtimePackage(
		"@earendil-works/pi-codemode",
		"1.4.0",
		stateDirectory,
		signal,
	);
	const manifest: unknown = JSON.parse(
		await readFile(installed.manifest, "utf8"),
	);
	if (
		!manifest ||
		typeof manifest !== "object" ||
		!("main" in manifest) ||
		typeof manifest.main !== "string"
	)
		throw new Error(
			"The JS Notebook runtime package is incomplete; reinstall it, then retry",
		);
	const runtime: typeof import("@earendil-works/pi-codemode") = await import(
		pathToFileURL(resolve(dirname(installed.manifest), manifest.main)).href
	);
	const engine = await runtimePackage(
		"quickjs-wasi",
		"3.6.3",
		stateDirectory,
		signal,
	);
	const wasm = await runtime.loadQuickJSWasm(
		engine.resolve("quickjs-wasi/quickjs.wasm"),
	);
	signal?.throwIfAborted();
	return {
		wasm,
		moduleUrl: pathToFileURL(engine.resolve("quickjs-wasi")).href,
	};
}
