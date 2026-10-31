import {
	type ComponentInstance,
	type ComponentRequest,
	defineCapability,
	isCapabilityObject,
} from "@howaboua/pi-durable-components";
import type { AgentsOptions } from "./contract.ts";
import { createAgents } from "./index.ts";

/** Registrations are executable objects; serialised profiles configure only native data fields. */
function configuredOptions(request: ComponentRequest): AgentsOptions {
	const value = request.configuration;
	if (
		Object.keys(value).some(
			(key) => !["profiles", "shareContext"].includes(key),
		)
	)
		throw new Error(
			"Unknown Agents configuration field; executable hooks require the advanced options capability",
		);
	if (!isCapabilityObject(value["profiles"]))
		throw new Error("Agents configuration.profiles is required");
	for (const [name, profile] of Object.entries(value["profiles"])) {
		if (!isCapabilityObject(profile) || !isCapabilityObject(profile["agent"]))
			throw new Error(`Invalid Agents profile: ${name}`);
		if (
			Object.keys(profile).some(
				(key) =>
					!["description", "agent", "blocking", "shareContext"].includes(key),
			)
		)
			throw new Error(`Unknown Agents profile field: ${name}`);
		const agent = profile["agent"];
		if (
			Object.keys(agent).some(
				(key) =>
					!["model", "thinkingLevel", "instructions", "cwd"].includes(key),
			)
		)
			throw new Error(
				`Agents profile ${name}: executable registrations require the advanced options capability`,
			);
		const model = agent["model"];
		if (
			model !== undefined &&
			model !== null &&
			!(
				isCapabilityObject(model) &&
				typeof model["provider"] === "string" &&
				typeof model["modelId"] === "string"
			)
		)
			throw new Error(`Invalid Agents profile model: ${name}`);
		const thinking = agent["thinkingLevel"];
		if (
			thinking !== undefined &&
			thinking !== null &&
			!(
				typeof thinking === "string" &&
				["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
					thinking,
				)
			)
		)
			throw new Error(`Invalid Agents profile thinkingLevel: ${name}`);
		for (const key of ["instructions", "cwd"])
			if (
				agent[key] !== undefined &&
				agent[key] !== null &&
				typeof agent[key] !== "string"
			)
				throw new Error(`Invalid Agents profile ${key}: ${name}`);
	}
	return agentsOptions.parse(value);
}

export const agentsOptions = defineCapability<AgentsOptions>(
	"howaboua.agents.options.v1",
	(value): value is AgentsOptions =>
		isCapabilityObject(value) &&
		isCapabilityObject(value["profiles"]) &&
		Object.values(value["profiles"]).every(
			(profile) =>
				isCapabilityObject(profile) &&
				typeof profile["description"] === "string" &&
				isCapabilityObject(profile["agent"]) &&
				(profile["blocking"] === undefined ||
					typeof profile["blocking"] === "boolean") &&
				(profile["shareContext"] === undefined ||
					typeof profile["shareContext"] === "boolean"),
		) &&
		(value["shareContext"] === undefined ||
			typeof value["shareContext"] === "boolean") &&
		(value["board"] === undefined ||
			(isCapabilityObject(value["board"]) &&
				typeof value["board"]["threadReference"] === "function")),
);

export function createComponent(
	request: ComponentRequest,
): ComponentInstance<ReturnType<typeof createAgents>> {
	const api = createAgents(
		request.capabilities.has(agentsOptions.id)
			? request.capabilities.get(agentsOptions)
			: configuredOptions(request),
	);
	let release: (() => void) | undefined;
	return {
		extensions: [api.extension],
		api,
		retention: "harness",
		bind({ harness, storage }) {
			api.bind(harness, storage);
			release = () => api.unbind(harness);
		},
		afterClose() {
			release?.();
			release = undefined;
		},
	};
}
