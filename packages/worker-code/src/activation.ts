import type { Harness } from "@earendil-works/pi-durable";
import {
	type ComponentInstance,
	type ComponentRequest,
	compiledWasmCapability,
	defineCapability,
	isCapabilityObject,
} from "@howaboua/pi-durable-components";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { createWorkerCode, type WorkerCodeOptions } from "./index.ts";

export const WORKER_CODE_WASM_ABI = "quickjs-emscripten/0.32.0/release-sync";

const configurationSchema = Type.Object(
	{
		limits: Type.Optional(
			Type.Record(Type.String(), Type.Integer({ minimum: 1 })),
		),
		modules: Type.Optional(Type.Record(Type.String(), Type.String())),
	},
	{ additionalProperties: false },
);

function baselineOptions(
	request: ComponentRequest,
): Omit<WorkerCodeOptions, "cancelTask"> {
	const configuration = request.configuration;
	if (!Check(configurationSchema, configuration))
		throw new Error("Invalid Worker Code component configuration");
	const wasm = request.capabilities.get(compiledWasmCapability);
	const wasmModule = wasm.moduleFor(WORKER_CODE_WASM_ABI);
	if (!(wasmModule instanceof WebAssembly.Module))
		throw new Error(
			`Compiled WASM grant did not provide ${WORKER_CODE_WASM_ABI}`,
		);
	return { ...configuration, wasmModule };
}

/** Optional complete constructor override; replaces baseline JSON configuration. */
export const workerCodeOptions = defineCapability<WorkerCodeOptions>(
	"howaboua.worker-code.options.v1",
	(value): value is WorkerCodeOptions =>
		isCapabilityObject(value) &&
		value["wasmModule"] instanceof WebAssembly.Module &&
		typeof value["cancelTask"] === "function" &&
		(value["limits"] === undefined || isCapabilityObject(value["limits"])) &&
		(value["modules"] === undefined ||
			typeof value["modules"] === "function" ||
			(isCapabilityObject(value["modules"]) &&
				Object.values(value["modules"]).every(
					(source) => typeof source === "string",
				))),
);

export function createComponent(
	request: ComponentRequest,
): ComponentInstance<ReturnType<typeof createWorkerCode>> {
	const options = request.capabilities.has(workerCodeOptions.id)
		? request.capabilities.get(workerCodeOptions)
		: baselineOptions(request);
	let owner: Harness | undefined;
	const api = createWorkerCode({
		...options,
		cancelTask(id, context) {
			if (!owner)
				throw new Error(
					"Worker Code component must be bound before cancellation",
				);
			return owner.abortTask(id, context);
		},
	});
	let closing: Promise<void> | undefined;
	return {
		extensions: [api.extension],
		api,
		retention: "harness",
		bind({ harness }) {
			if (owner && owner !== harness)
				throw new Error(
					"Worker Code component is already bound to another Harness",
				);
			api.bind(harness);
			owner = harness;
		},
		beforeClose() {
			return (closing ??= api.close());
		},
		afterClose() {
			owner = undefined;
		},
	};
}
