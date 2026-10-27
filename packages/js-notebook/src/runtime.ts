import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
	type CodemodeWasmModule,
	loadQuickJSWasm,
} from "@earendil-works/pi-codemode";

export interface JsRuntime {
	wasm: CodemodeWasmModule;
	moduleUrl: string;
}

/** Published public runtime exports only. Installation belongs to the consuming app. */
export async function loadJsRuntime(
	_stateDirectory: string,
	signal?: AbortSignal,
): Promise<JsRuntime> {
	signal?.throwIfAborted();
	const resolve = createRequire(import.meta.url).resolve;
	const wasm = await loadQuickJSWasm(resolve("quickjs-wasi/quickjs.wasm"));
	signal?.throwIfAborted();
	return { wasm, moduleUrl: pathToFileURL(resolve("quickjs-wasi")).href };
}
