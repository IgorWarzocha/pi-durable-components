// Adapted from howaboua-pi-stuff at 84bd5bce, MIT. See ../NOTICE.
import type { API } from "tsrs/async";
import { startTsCompiler } from "./compiler-process.ts";
import type { TsImportOptions } from "./imports.ts";
import { loadTsRuntime, type TsRuntime } from "./runtime.ts";

export async function resolveTsSource(
	specifier: string,
	cwd: string,
	api: API,
	runtime: TsRuntime,
	mode: "import" | "require",
): Promise<string | undefined> {
	const { ModuleKind, ModuleResolutionKind } = runtime.api;
	const resolver = await api.createModuleResolver({
		module: ModuleKind.NodeNext,
		moduleResolution: ModuleResolutionKind.NodeNext,
	});
	try {
		return (
			await resolver.resolveModuleName(
				specifier,
				cwd,
				mode === "require" ? ModuleKind.CommonJS : ModuleKind.ESNext,
			)
		).resolvedModule?.resolvedFileName;
	} finally {
		await resolver.dispose();
	}
}

export async function withTsImportApi<T>(
	options: TsImportOptions,
	operation: (api: API, runtime: TsRuntime) => Promise<T>,
): Promise<T> {
	if (options.compiler) return options.compiler.withApi(operation);
	const runtime = await loadTsRuntime(options.agentDir, options.signal);
	const compiler = await startTsCompiler(runtime, { cwd: options.cwd });
	try {
		return await operation(compiler.api, runtime);
	} finally {
		await compiler.close();
	}
}
