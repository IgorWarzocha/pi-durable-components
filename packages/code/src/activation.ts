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
	type CodeModeOptions,
	createCodeMode,
	createNodeShellBackend,
} from "./index.ts";

const configurationSchema = Type.Object(
	{
		hostPath: Type.Optional(Type.String({ minLength: 1 })),
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
): Omit<CodeModeOptions, "cancelTask"> {
	const configuration = request.configuration;
	if (!Check(configurationSchema, configuration))
		throw new Error("Invalid Code component configuration");
	const native = request.capabilities.get(nodeExecutionCapability);
	const state = request.capabilities.get(stateCapability);
	return {
		...configuration,
		cacheDirectory: state.directory("code"),
		shell: { ...configuration.shell, backend: createNodeShellBackend(native) },
	};
}

/** Optional complete constructor override; replaces baseline JSON configuration. */
export const codeOptions = defineCapability<CodeModeOptions>(
	"howaboua.code.options.v1",
	(value): value is CodeModeOptions =>
		isCapabilityObject(value) &&
		typeof value["cancelTask"] === "function" &&
		isCapabilityObject(value["shell"]) &&
		isCapabilityObject(value["shell"]["backend"]) &&
		typeof value["shell"]["backend"]["environmentId"] === "string" &&
		value["shell"]["backend"]["environmentId"].length > 0 &&
		typeof value["shell"]["backend"]["spawn"] === "function" &&
		typeof value["shell"]["backend"]["platform"] === "string" &&
		typeof value["shell"]["backend"]["defaultShell"] === "string" &&
		isCapabilityObject(value["shell"]["backend"]["env"]) &&
		(value["hostPath"] === undefined ||
			typeof value["hostPath"] === "string") &&
		(value["cacheDirectory"] === undefined ||
			typeof value["cacheDirectory"] === "string"),
);

export function createComponent(
	request: ComponentRequest,
): ComponentInstance<ReturnType<typeof createCodeMode>> {
	const options = request.capabilities.has(codeOptions.id)
		? request.capabilities.get(codeOptions)
		: baselineOptions(request);
	let owner: Harness | undefined;
	const api = createCodeMode({
		...options,
		cancelTask(id, context) {
			if (!owner)
				throw new Error("Code component must be bound before cancellation");
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
				throw new Error("Code component is already bound to another Harness");
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
