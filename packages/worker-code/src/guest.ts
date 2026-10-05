import type { JsonValue } from "@earendil-works/chord";
import type { QuickJSHandle } from "quickjs-emscripten";
import { admitRuntime } from "./interpreter.ts";
import { boundedJson, boundedString, type WorkerCodeLimits } from "./limits.ts";
import { resolveModule } from "./modules.ts";

export interface GuestCapabilities {
	readonly inventory?: JsonValue;
	readonly tools?: Readonly<
		Record<string, (args: JsonValue, signal: AbortSignal) => Promise<unknown>>
	>;
	readonly emit?: (kind: "text" | "image", value: JsonValue) => Promise<void>;
	readonly yield?: () => Promise<void>;
}

export interface GuestResult {
	value: JsonValue;
	polls: number;
	jobs: number;
	calls: number;
}

/** Deferred promises permit concurrent ordinary tools without Asyncify suspension limits. */
export async function runGuest(
	wasm: WebAssembly.Module,
	code: string,
	sources: ReadonlyMap<string, string>,
	limits: Readonly<WorkerCodeLimits>,
	signal: AbortSignal,
	capabilities: GuestCapabilities = {},
): Promise<GuestResult> {
	boundedString(code, limits.maxSourceBytes, "Source");
	const owner = new AbortController();
	const combined = AbortSignal.any([owner.signal, signal]);
	const admitted = await admitRuntime(wasm, limits.heapBytes, combined);
	const runtime = admitted.runtime;
	try {
		runtime.setMemoryLimit(limits.heapBytes);
		runtime.setMaxStackSize(limits.stackBytes);
		let polls = 0,
			calls = 0,
			jobs = 0,
			closed = false;
		runtime.setInterruptHandler(
			() => combined.aborted || ++polls > limits.fuel,
		);
		runtime.setModuleLoader(
			(name) =>
				sources.get(name) ?? {
					error: new Error(`Module ${name} is not in the workspace snapshot`),
				},
			(base, name) => {
				try {
					return resolveModule(base, name);
				} catch (error) {
					return {
						error: error instanceof Error ? error : new Error(String(error)),
					};
				}
			},
		);
		const vm = runtime.newContext();
		const pending = new Map<Promise<void>, ReturnType<typeof vm.newPromise>>();
		let promise: QuickJSHandle | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let onAbort: (() => void) | undefined;
		let outputBytes = 0;
		let outputFailure: unknown;
		try {
			const failure = (error: unknown) => ({
				error: vm.newError(
					error instanceof Error ? error.message : String(error),
				),
			});
			const bridge = vm.newFunction(
				"dispatch",
				(kindHandle, nameHandle, argsHandle) => {
					try {
						combined.throwIfAborted();
						const kind = vm.getString(kindHandle);
						const name = vm.getString(nameHandle);
						const serialized = boundedString(
							vm.getString(argsHandle),
							kind === "tool" ? limits.maxArgumentBytes : limits.maxOutputBytes,
							"Bridge input",
						);
						const args: JsonValue = JSON.parse(serialized);
						if (pending.size >= limits.maxPendingCalls)
							throw new Error("Guest pending call limit exceeded");
						let perform: () => Promise<unknown>;
						if (kind === "tool") {
							if (++calls > limits.maxCalls)
								throw new Error("Guest tool call limit exceeded");
							const tool = Object.hasOwn(capabilities.tools ?? {}, name)
								? capabilities.tools?.[name]
								: undefined;
							if (!tool) throw new Error(`Tool ${name} is unavailable`);
							perform = () => tool(args, combined);
						} else if (
							(kind === "text" || kind === "image") &&
							capabilities.emit
						) {
							outputBytes += new TextEncoder().encode(serialized).byteLength;
							if (outputBytes > limits.maxOutputBytes)
								throw new Error("Guest output byte limit exceeded");
							perform = () =>
								capabilities.emit?.(kind, args) ?? Promise.resolve();
						} else if (kind === "yield" && capabilities.yield) {
							perform = capabilities.yield;
						} else throw new Error(`Guest capability ${kind} is unavailable`);
						const deferred = vm.newPromise();
						const work = Promise.resolve().then(async () => {
							try {
								const result = await perform();
								const serialized = boundedJson(
									result ?? null,
									limits.maxResultBytes,
									"Bridge result",
								);
								if (!closed) {
									const value = vm.newString(serialized);
									try {
										deferred.resolve(value);
									} finally {
										value.dispose();
									}
								}
							} catch (error) {
								if (kind !== "tool") outputFailure = error;
								if (!closed) {
									const value = vm.newError(
										error instanceof Error ? error.message : String(error),
									);
									try {
										deferred.reject(value);
									} finally {
										value.dispose();
									}
								}
							} finally {
								pending.delete(work);
								deferred.dispose();
							}
						});
						pending.set(work, deferred);
						return deferred.handle.dup();
					} catch (error) {
						if (vm.getString(kindHandle) !== "tool") outputFailure = error;
						return failure(error);
					}
				},
			);
			vm.setProp(vm.global, "__dispatch", bridge);
			bridge.dispose();
			if (capabilities.inventory !== undefined) {
				const inventory = vm.newString(
					boundedJson(
						capabilities.inventory,
						limits.maxResultBytes,
						"Tool inventory",
					),
				);
				try {
					vm.setProp(vm.global, "__inventory", inventory);
				} finally {
					inventory.dispose();
				}
			}
			vm.unwrapResult(
				vm.evalCode(`(() => {
			const dispatch = globalThis.__dispatch;
			delete globalThis.__dispatch;
			const call = async (kind, name, value) => JSON.parse(await dispatch(kind, name, JSON.stringify(value ?? null)));
			globalThis.tools = Object.create(null);
			for (const name of ${JSON.stringify(Object.keys(capabilities.tools ?? {}))})
				tools[name] = args => call("tool", name, args);
			Object.freeze(tools);
			${capabilities.inventory !== undefined ? "globalThis.ALL_TOOLS = JSON.parse(globalThis.__inventory); delete globalThis.__inventory;" : ""}
			${capabilities.emit ? 'globalThis.text = value => call("text", "", value); globalThis.image = value => call("image", "", value);' : ""}
			${capabilities.yield ? 'globalThis.yield_control = () => call("yield", "", null);' : ""}
		})()`),
			).dispose();
			combined.throwIfAborted();
			promise = vm.unwrapResult(
				vm.evalCode(
					`(async () => {\n${code}\n})().then(value => JSON.stringify(value ?? null))`,
					"/cell.js",
				),
			);
			const aborted = new Promise<never>((_, reject) => {
				onAbort = () => reject(combined.reason);
				combined.addEventListener("abort", onAbort, { once: true });
				if (combined.aborted) onAbort();
			});
			// Wall time bounds I/O only. Fuel and job limits stop guest loops in Workers' frozen clock.
			const timeout = new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("Guest host wait limit exceeded")),
					limits.waitMs,
				);
			});
			while (true) {
				combined.throwIfAborted();
				if (outputFailure !== undefined) throw outputFailure;
				if (jobs >= limits.maxJobs) throw new Error("Guest job limit exceeded");
				const executed = runtime.executePendingJobs(
					Math.min(64, limits.maxJobs - jobs),
				);
				if (executed.error) {
					try {
						throw new Error(JSON.stringify(vm.dump(executed.error)));
					} finally {
						executed.error.dispose();
					}
				}
				jobs += executed.value;
				const state = vm.getPromiseState(promise);
				if (state.type === "rejected") {
					try {
						throw new Error(JSON.stringify(vm.dump(state.error)));
					} finally {
						state.error.dispose();
					}
				}
				if (state.type === "fulfilled") {
					try {
						if (!pending.size && !runtime.hasPendingJob()) {
							const serialized = boundedString(
								vm.getString(state.value),
								limits.maxResultBytes,
								"Return value",
							);
							return { value: JSON.parse(serialized), polls, jobs, calls };
						}
					} finally {
						state.value.dispose();
					}
				}
				if (runtime.hasPendingJob()) continue;
				if (!pending.size)
					throw new Error("Guest promise has no owned host work");
				await Promise.race([...pending.keys(), aborted, timeout]);
			}
		} finally {
			closed = true;
			clearTimeout(timer);
			if (onAbort) combined.removeEventListener("abort", onAbort);
			owner.abort(new Error("Guest execution ended"));
			await Promise.allSettled(pending.keys());
			promise?.dispose();
			vm.dispose();
		}
	} finally {
		try {
			runtime.dispose();
		} finally {
			admitted.release();
		}
	}
}
