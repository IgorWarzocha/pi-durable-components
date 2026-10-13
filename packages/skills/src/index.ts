import type { Context } from "@earendil-works/chord";
import {
	defineExtension,
	defineTool,
	section,
	type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { runSkills } from "./catalog.ts";
import type { LoadedSkill, SkillsCatalogOptions } from "./discovery.ts";
import { SkillFiles } from "./files.ts";

export { parseRequest, runSkills } from "./catalog.ts";
export type {
	CatalogSkill,
	LoadedSkill,
	SkillsCatalogOptions,
} from "./discovery.ts";
export { discoverSkills, discoverVisibleSkills } from "./discovery.ts";
export { SkillFiles } from "./files.ts";

export interface SkillsOptions extends SkillsCatalogOptions {
	/** Resolve an authoritative catalog per invocation, in the conversation's environment. */
	getLoadedSkills?(
		api: ToolExecutionApi,
		context: Context,
	): readonly LoadedSkill[] | Promise<readonly LoadedSkill[]>;
	guidance?: boolean;
}

const SkillsParameters = Type.Object(
	{
		command: Type.Optional(Type.String({ description: "Omit for discovery" })),
	},
	{ additionalProperties: false },
);

function prepareSkillsInput(input: unknown): { command?: string } {
	if (input === undefined) return {};
	if (typeof input === "string") return { command: input };
	if (typeof input !== "object" || input === null || Array.isArray(input))
		throw new Error("skills expects a string command or command envelope");
	if ("command" in input && typeof input.command !== "string")
		throw new Error("skills command must be a string");
	return input;
}

export function createSkillsTool(options: SkillsOptions = {}) {
	return defineTool({
		name: "skills",
		description: "Load skill instructions and references",
		parameters: SkillsParameters,
		prepareArguments: prepareSkillsInput,
		replay: "safe",
		// Source output has its own byte continuation. Do not cut off its continuation footer or long lines.
		outputLimits: { maxBytes: 48 * 1024, maxLines: Number.MAX_SAFE_INTEGER },
		async execute(args, api, context) {
			if (!api.env)
				throw new Error(
					"skills requires the conversation's filesystem environment",
				);
			const files = new SkillFiles(api.env, context);
			files.check();
			const loadedSkills = options.getLoadedSkills
				? await options.getLoadedSkills(api, context)
				: options.loadedSkills;
			const catalog: SkillsCatalogOptions = {
				...(options.globalRoot === undefined
					? {}
					: { globalRoot: options.globalRoot }),
				...(options.sessionRoot === undefined
					? {}
					: { sessionRoot: options.sessionRoot }),
				...(loadedSkills === undefined ? {} : { loadedSkills }),
			};
			const output = await runSkills(args.command ?? "", files, catalog);
			return { output: [{ type: "text", text: output }], details: {} };
		},
	});
}

export function skills(options: SkillsOptions = {}) {
	const tool = createSkillsTool(options);
	return defineExtension({
		name: "skills",
		tools: [tool],
		...(options.guidance
			? {
					sections: [
						section("skills_guidance", (input) =>
							input.agent.tools.some(
								(registered) => registered.name === tool.name,
							)
								? "List once at session start. Read always-applicable and task-relevant skills before work."
								: undefined,
						),
					],
				}
			: {}),
	});
}
