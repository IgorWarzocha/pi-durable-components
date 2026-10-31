import {
	type ComponentInstance,
	type ComponentRequest,
	defineCapability,
	isCapabilityObject,
} from "@howaboua/pi-durable-components";
import { createNestedAgentsMd } from "./index.ts";

type NestedAgentsMdOptions = NonNullable<
	Parameters<typeof createNestedAgentsMd>[0]
>;

export const nestedAgentsMdOptions = defineCapability<NestedAgentsMdOptions>(
	"howaboua.nested-agents-md.options.v1",
	(value): value is NestedAgentsMdOptions =>
		isCapabilityObject(value) &&
		(value["fileNames"] === undefined ||
			(Array.isArray(value["fileNames"]) &&
				value["fileNames"].every((name) => typeof name === "string"))),
);

export function createComponent(
	request: ComponentRequest,
): ComponentInstance<ReturnType<typeof createNestedAgentsMd>> {
	const api = createNestedAgentsMd(
		request.capabilities.has(nestedAgentsMdOptions.id)
			? request.capabilities.get(nestedAgentsMdOptions)
			: nestedAgentsMdOptions.parse(request.configuration),
	);
	return { extensions: [api], api, retention: "idle" };
}
