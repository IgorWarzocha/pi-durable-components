import {
	newQuickJSWASMModule,
	newVariant,
	type QuickJSRuntime,
	RELEASE_SYNC,
} from "quickjs-emscripten";

// One interpreter and one hard memory ceiling per isolate, including multiple Harness owners.
// Fail-fast admission avoids a nested guest waiting for a slot held by its own caller.
let interpreter:
	| {
			wasm: WebAssembly.Module;
			memory: WebAssembly.Memory;
			module: ReturnType<typeof newQuickJSWASMModule>;
			active: number;
			heap: number;
	  }
	| undefined;

export const WORKER_CODE_ISOLATE_BUDGET = Object.freeze({
	maxRuntimes: 4,
	maxReservedHeapBytes: 24 * 1024 * 1024,
	initialWasmBytes: 16 * 1024 * 1024,
	maxWasmBytes: 32 * 1024 * 1024,
});

export async function admitRuntime(
	wasm: WebAssembly.Module,
	heapBytes: number,
	signal: AbortSignal,
): Promise<{ runtime: QuickJSRuntime; release(): void }> {
	signal.throwIfAborted();
	if (!interpreter) {
		const memory = new WebAssembly.Memory({ initial: 256, maximum: 512 });
		interpreter = {
			wasm,
			memory,
			module: newQuickJSWASMModule(
				newVariant(RELEASE_SYNC, { wasmModule: wasm, wasmMemory: memory }),
			),
			active: 0,
			heap: 0,
		};
	}
	const pool = interpreter;
	if (pool.wasm !== wasm)
		throw new Error(
			"Worker Code already has a different compiled WASM module in this isolate",
		);
	if (
		pool.active >= WORKER_CODE_ISOLATE_BUDGET.maxRuntimes ||
		pool.heap + heapBytes > WORKER_CODE_ISOLATE_BUDGET.maxReservedHeapBytes
	)
		throw new Error(
			"Worker Code isolate runtime budget exhausted. Wait for admitted work to finish",
		);
	pool.active++;
	pool.heap += heapBytes;
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		pool.active--;
		pool.heap -= heapBytes;
	};
	try {
		const module = await pool.module;
		signal.throwIfAborted();
		return { runtime: module.newRuntime(), release };
	} catch (error) {
		release();
		throw error;
	}
}

export function interpreterBudget() {
	return {
		activeRuntimes: interpreter?.active ?? 0,
		reservedHeapBytes: interpreter?.heap ?? 0,
		wasmMemoryBytes: interpreter?.memory.buffer.byteLength ?? 0,
		...WORKER_CODE_ISOLATE_BUDGET,
	};
}
