import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export interface TsRuntime {
	api: typeof import("tsrs/async");
	ast: typeof import("tsrs/ast");
	fs: typeof import("tsrs/fs");
	typeRoots: string[];
	launcher: string;
}

/** Runtime dependencies are installed by the host package manager, never on first use. */
export async function loadTsRuntime(
	_stateDirectory: string,
	signal?: AbortSignal,
): Promise<TsRuntime> {
	signal?.throwIfAborted();
	const require = createRequire(import.meta.url);
	const [api, ast, fs] = await Promise.all([
		import("tsrs/async"),
		import("tsrs/ast"),
		import("tsrs/fs"),
	]);
	signal?.throwIfAborted();
	return {
		api,
		ast,
		fs,
		typeRoots: [dirname(dirname(require.resolve("@types/node/package.json")))],
		launcher: join(
			dirname(require.resolve("tsrs/package.json")),
			"bin",
			"tsrs",
		),
	};
}
