// Adapted from pi-better-skills-tool at b2006db9. MIT, Copyright (c) 2026 Igor Warzocha.
import type { CatalogSkill } from "./discovery.ts";
import { SkillFiles } from "./files.ts";
import { packageFiles } from "./package-files.ts";
import {
	type ReadSelection,
	type ReferenceSelection,
	selectSkillPackage,
} from "./skill-selection.ts";

async function formatSkill(
	skill: CatalogSkill,
	files: SkillFiles,
): Promise<string> {
	const paths = await packageFiles(skill, files);
	return `${skill.body}\n\n---\nSkill paths (${paths.length}):\n${paths.map((path) => `- ${path}`).join("\n")}`;
}

async function formatReferences(
	selected: ReferenceSelection[],
	files: SkillFiles,
): Promise<string> {
	const oneSkill = new Set(selected.map(({ skill }) => skill.name)).size === 1;
	const withContent: (ReferenceSelection & { content: string })[] = [];
	for (const selection of selected) {
		withContent.push({
			...selection,
			content: (await files.text(selection.path)).trim(),
		});
	}
	const content =
		withContent.length === 1
			? (withContent[0]?.content ?? "")
			: withContent
					.map(({ skill, reference, content: body }) => {
						const label = oneSkill
							? reference
							: `${skill.name}/references/${reference}`;
						return `--- ${label} ---\n${body}`;
					})
					.join("\n\n");
	return `${content}\n\n---\nSources:\n${withContent.map(({ path }) => `- ${path}`).join("\n")}`;
}

async function formatMixedSelections(
	selections: ReadSelection[],
	files: SkillFiles,
): Promise<string> {
	const parts: string[] = [];
	for (const selection of selections) {
		parts.push(
			selection.kind === "skill"
				? `--- ${selection.skill.name} ---\n${await formatSkill(selection.skill, files)}`
				: `--- ${selection.skill.name}/references/${selection.reference} ---\n${(await files.text(selection.path)).trim()}`,
		);
	}
	const content = parts.join("\n\n");
	const sources = selections
		.filter(
			(selection): selection is ReferenceSelection =>
				selection.kind === "reference",
		)
		.map(({ path }) => `- ${path}`);
	return sources.length
		? `${content}\n\n---\nSources:\n${sources.join("\n")}`
		: content;
}

export async function readSkillPackage(
	skills: CatalogSkill[],
	name: string,
	selectors: string[],
	files: SkillFiles,
): Promise<string> {
	const selections = await selectSkillPackage(skills, name, selectors, files);
	if (selections.length === 1) {
		const selection = selections[0] as ReadSelection;
		return selection.kind === "skill"
			? await formatSkill(selection.skill, files)
			: formatReferences([selection], files);
	}
	return selections.every(
		(selection): selection is ReferenceSelection =>
			selection.kind === "reference",
	)
		? formatReferences(selections, files)
		: formatMixedSelections(selections, files);
}
