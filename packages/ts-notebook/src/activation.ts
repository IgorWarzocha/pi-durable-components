import type { Harness } from "@earendil-works/pi-durable";
import {
	type ComponentInstance,
	type ComponentRequest,
	defineCapability,
	isCapabilityObject,
	nodeExecutionCapability,
	stateCapability,
} from "@howaboua/pi-durable-components";
import { Type } from "typebox";
import { Check } from "typebox/value";
import {
	createNodeShellBackend,
	createTsNotebookMode,
	type NotebookModeOptions,
} from "./index.ts";

const configurationSchema = Type.Object(
	{
		maxHeapMiB: Type.Optional(Type.Integer({ minimum: 128 })),
		profile: Type.Optional(Type.String()),
		shell: Type.Optional(
			Type.Object(
				{
					maxSessionBufferChars: Type.Optional(Type.Integer({ minimum: 1 })),
					defaultExecYieldTimeMs: Type.Optional(Type.Number({ minimum: 0 })),
					defaultWriteYieldTimeMs: Type.Optional(Type.Number({ minimum: 0 })),
					minNonInteractiveExecYieldTimeMs: Type.Optional(
						Type.Number({ minimum: 0 }),
					),
					minEmptyWriteYieldTimeMs: Type.Optional(Type.Number({ minimum: 0 })),
					maxEmptyWriteYieldTimeMs: Type.Optional(Type.Number({ minimum: 0 })),
					waitForNonInteractiveExit: Type.Optional(Type.Boolean()),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

function baselineOptions(
	request: ComponentRequest,
): Omit<NotebookModeOptions, "cancelTask"> {
	const configuration = request.configuration;
	if (!Check(configurationSchema, configuration))
		throw new Error("Invalid TypeScript Notebook component configuration");
	const native = request.capabilities.get(nodeExecutionCapability);
	const state = request.capabilities.get(stateCapability);
	return {
		...configuration,
		stateDirectory: state.directory("ts-notebook"),
		native: { environmentId: native.environmentId },
		shell: { ...configuration.shell, backend: createNodeShellBackend(native) },
	};
}

/** Optional complete constructor override; replaces baseline JSON configuration. */
export const tsNotebookOptions = defineCapability<NotebookModeOptions>(
	"howaboua.ts-notebook.options.v1",
	(value): value is NotebookModeOptions =>
		isCapabilityObject(value) &&
		typeof value["cancelTask"] === "function" &&
		typeof value["stateDirectory"] === "string" &&
		value["stateDirectory"].length > 0 &&
		isCapabilityObject(value["native"]) &&
		typeof value["native"]["environmentId"] === "string" &&
		value["native"]["environmentId"].length > 0 &&
		isCapabilityObject(value["shell"]) &&
		isCapabilityObject(value["shell"]["backend"]) &&
		value["shell"]["backend"]["environmentId"] ===
			value["native"]["environmentId"] &&
		typeof value["shell"]["backend"]["spawn"] === "function" &&
		typeof value["shell"]["backend"]["platform"] === "string" &&
		typeof value["shell"]["backend"]["defaultShell"] === "string" &&
		isCapabilityObject(value["shell"]["backend"]["env"]) &&
		(value["maxHeapMiB"] === undefined ||
			typeof value["maxHeapMiB"] === "number") &&
		(value["profile"] === undefined || typeof value["profile"] === "string"),
);

export function createComponent(
	request: ComponentRequest,
): ComponentInstance<ReturnType<typeof createTsNotebookMode>> {
	const options = request.capabilities.has(tsNotebookOptions.id)
		? request.capabilities.get(tsNotebookOptions)
		: baselineOptions(request);
	let owner: Harness | undefined;
	const api = createTsNotebookMode({
		...options,
		cancelTask(id, context) {
			if (!owner)
				throw new Error(
					"TypeScript Notebook component must be bound before cancellation",
				);
			return owner.abortTask(id, context);
		},
	});
	return {
		extensions: [api.extension],
		api,
		retention: "harness",
		bind({ harness }) {
			if (owner && owner !== harness)
				throw new Error(
					"TypeScript Notebook component is already bound to another Harness",
				);
			api.bind(harness);
			owner = harness;
		},
		beforeClose() {
			return api.close();
		},
		afterClose() {
			owner = undefined;
		},
	};
}
