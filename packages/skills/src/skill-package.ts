// Adapted from pi-better-skills-tool at b2006db9. MIT, Copyright (c) 2026 Igor Warzocha.
import { Buffer } from "node:buffer";
import type { CatalogSkill } from "./discovery.ts";
import { SkillFiles } from "./files.ts";
import { packageFiles } from "./package-files.ts";
import { selectSkillPackage } from "./skill-selection.ts";

type SkillRead = {
	name: string;
	skillPath: string;
	path: string;
	kind: "skill" | "reference";
};

export interface SkillReadOutput {
	output: string;
	reads: { read: SkillRead; start: number; end: number }[];
}

export async function readSkillPackage(
	skills: CatalogSkill[],
	name: string,
	selectors: string[],
	files: SkillFiles,
): Promise<SkillReadOutput> {
	const selections = await selectSkillPackage(skills, name, selectors, files);
	const referencesOnly = selections.every(({ kind }) => kind === "reference");
	const oneSkill =
		new Set(selections.map(({ skill }) => skill.name)).size === 1;
	const result: SkillReadOutput = { output: "", reads: [] };
	const sources: string[] = [];
	for (const selection of selections) {
		if (result.reads.length) result.output += "\n\n";
		const { skill, kind } = selection;
		const path = kind === "skill" ? skill.path : selection.path;
		const body =
			kind === "skill" ? skill.body : (await files.text(path)).trim();
		if (selections.length > 1) {
			const label =
				kind === "skill"
					? skill.name
					: referencesOnly && oneSkill
						? selection.reference
						: `${skill.name}/references/${selection.reference}`;
			result.output += `--- ${label} ---\n`;
		}
		const start = Buffer.byteLength(result.output);
		result.output += body;
		result.reads.push({
			read: { name: skill.name, skillPath: skill.path, path, kind },
			start,
			end: Buffer.byteLength(result.output),
		});
		if (kind === "skill") {
			const paths = await packageFiles(skill, files);
			result.output += `\n\n---\nSkill paths (${paths.length}):\n${paths.map((path) => `- ${path}`).join("\n")}`;
		} else sources.push(`- ${path}`);
	}
	if (sources.length)
		result.output += `\n\n---\nSources:\n${sources.join("\n")}`;
	return result;
}
