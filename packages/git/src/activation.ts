import { defineExtension } from "@earendil-works/pi-durable";
import {
	type ComponentInstance,
	type ComponentRequest,
	defineCapability,
	isCapabilityObject,
	nodeExecutionCapability,
} from "@howaboua/pi-durable-components";
import {
	createGitDiffTool,
	createNativeGitReader,
	type GitToolOptions,
} from "./index.ts";

export const gitOptions = defineCapability<GitToolOptions>(
	"howaboua.git.options.v1",
	(value): value is GitToolOptions =>
		isCapabilityObject(value) &&
		typeof value["readerForEnvironment"] === "function",
);

export function createComponent(
	request: ComponentRequest,
): ComponentInstance<ReturnType<typeof createGitDiffTool>> {
	let options: GitToolOptions;
	if (request.capabilities.has(gitOptions.id)) {
		options = request.capabilities.get(gitOptions);
	} else {
		const grant = request.capabilities.get(nodeExecutionCapability);
		const reader = createNativeGitReader();
		options = {
			readerForEnvironment: (environment) =>
				environment.id === grant.environmentId ? reader : undefined,
		};
	}
	const api = createGitDiffTool(options);
	return {
		extensions: [defineExtension({ name: "howaboua.git", tools: [api] })],
		api,
		retention: "idle",
	};
}
