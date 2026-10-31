import { defineExtension } from "@earendil-works/pi-durable";
import {
	type ComponentInstance,
	type ComponentRequest,
	defineCapability,
	isCapabilityObject,
	modelsCapability,
	nodeExecutionCapability,
} from "@howaboua/pi-durable-components";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { createViewImageTool, type ViewImageOptions } from "./index.ts";

/** Grants native byte codecs and the host's exact Models collection. */
export const viewImageOptions = defineCapability<ViewImageOptions>(
	"howaboua.view-image.options.v1",
	(value): value is ViewImageOptions =>
		isCapabilityObject(value) &&
		isCapabilityObject(value["models"]) &&
		typeof value["models"]["getModel"] === "function",
);

const configuration = Type.Object(
	{
		describeForTextModels: Type.Optional(Type.Boolean()),
		descriptionModel: Type.Optional(
			Type.Object(
				{ provider: Type.String(), modelId: Type.String() },
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

function baseline(request: ComponentRequest): ViewImageOptions {
	if (!Check(configuration, request.configuration))
		throw new Error("Invalid view-image configuration");
	request.capabilities.get(nodeExecutionCapability);
	return {
		...request.configuration,
		models: request.capabilities.get(modelsCapability),
	};
}

export function createComponent(
	request: ComponentRequest,
): ComponentInstance<ReturnType<typeof createViewImageTool>> {
	const api = createViewImageTool(
		request.capabilities.has(viewImageOptions.id)
			? request.capabilities.get(viewImageOptions)
			: baseline(request),
	);
	return {
		extensions: [defineExtension({ name: "view-image", tools: [api] })],
		api,
		retention: "idle",
	};
}
