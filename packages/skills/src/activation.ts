import {
	type ComponentInstance,
	type ComponentRequest,
	defineCapability,
	isCapabilityObject,
} from "@howaboua/pi-durable-components";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { type SkillsOptions, skills } from "./index.ts";

export const skillsOptions = defineCapability<SkillsOptions>(
	"howaboua.skills.options.v1",
	(value): value is SkillsOptions =>
		isCapabilityObject(value) &&
		(value["globalRoot"] === undefined ||
			typeof value["globalRoot"] === "string") &&
		(value["sessionRoot"] === undefined ||
			typeof value["sessionRoot"] === "string") &&
		(value["loadedSkills"] === undefined ||
			Array.isArray(value["loadedSkills"])) &&
		(value["getLoadedSkills"] === undefined ||
			typeof value["getLoadedSkills"] === "function") &&
		(value["guidance"] === undefined || typeof value["guidance"] === "boolean"),
);

const configuration = Type.Object(
	{
		globalRoot: Type.Optional(Type.String()),
		sessionRoot: Type.Optional(Type.String()),
		guidance: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

function baseline(request: ComponentRequest): SkillsOptions {
	if (!Check(configuration, request.configuration))
		throw new Error("Invalid skills configuration");
	return request.configuration;
}

export function createComponent(
	request: ComponentRequest,
): ComponentInstance<ReturnType<typeof skills>> {
	const api = skills(
		request.capabilities.has(skillsOptions.id)
			? request.capabilities.get(skillsOptions)
			: baseline(request),
	);
	return { extensions: [api], api, retention: "idle" };
}
