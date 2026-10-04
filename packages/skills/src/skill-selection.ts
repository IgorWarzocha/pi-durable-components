// Adapted from pi-better-skills-tool at b2006db9. MIT, Copyright (c) 2026 Igor Warzocha.
import type { CatalogSkill } from "./discovery.ts";
import { isAbsolute, SkillFiles } from "./files.ts";
import { referencePaths } from "./package-files.ts";

function withoutMarkdownSuffix(name: string): string {
	return name.replace(/\.md$/i, "");
}

function normalizedPath(name: string): string {
	return name.replaceAll("\\", "/");
}

function stripPathPrefix(name: string, prefix: string): string {
	return name.toLowerCase().startsWith(prefix.toLowerCase())
		? name.slice(prefix.length)
		: name;
}

function referenceCandidates(name: string, skill: CatalogSkill): string[] {
	const normalized = normalizedPath(name);
	const packageRelative = stripPathPrefix(
		stripPathPrefix(normalized, "./references/"),
		"references/",
	);
	const skillRelative = stripPathPrefix(
		packageRelative,
		`${skill.name}/references/`,
	);
	return [
		...new Set([
			name,
			withoutMarkdownSuffix(name),
			normalized,
			withoutMarkdownSuffix(normalized),
			packageRelative,
			withoutMarkdownSuffix(packageRelative),
			skillRelative,
			withoutMarkdownSuffix(skillRelative),
		]),
	];
}

function findSkillByName(
	skills: CatalogSkill[],
	name: string,
): CatalogSkill | undefined {
	return (
		skills.find((skill) => skill.name === name) ??
		skills.find((skill) => skill.name === withoutMarkdownSuffix(name))
	);
}

async function isOwnSkillDocument(
	name: string,
	skill: CatalogSkill,
	files: SkillFiles,
): Promise<boolean> {
	const normalized = normalizedPath(name).toLowerCase();
	return (
		normalized === "skill.md" ||
		normalized === `${skill.name}/skill.md` ||
		(isAbsolute(name) && (await files.absolute(name)) === skill.path)
	);
}

interface SkillSelection {
	kind: "skill";
	skill: CatalogSkill;
}

export interface ReferenceSelection {
	kind: "reference";
	skill: CatalogSkill;
	reference: string;
	path: string;
}

export type ReadSelection = SkillSelection | ReferenceSelection;
type ReferenceCatalog = Map<CatalogSkill, Map<string, string>>;

async function findReference(
	skill: CatalogSkill,
	name: string,
	catalog: ReferenceCatalog,
	files: SkillFiles,
): Promise<ReferenceSelection | undefined> {
	let available = catalog.get(skill);
	if (!available) {
		available = await referencePaths(skill, files);
		catalog.set(skill, available);
	}
	const absolute = isAbsolute(name) ? await files.absolute(name) : undefined;
	const reference =
		(absolute
			? [...available].find(([, path]) => path === absolute)?.[0]
			: undefined) ??
		referenceCandidates(name, skill).find((candidate) =>
			available.has(candidate),
		);
	const path = reference ? available.get(reference) : undefined;
	return reference && path
		? { kind: "reference", skill, reference, path }
		: undefined;
}

function unknownReferenceForSkill(name: string, skill: CatalogSkill): never {
	throw new Error(
		`Unknown reference "${name}" for skill "${skill.name}". Use "read ${skill.name}" to inspect its reference paths`,
	);
}

async function resolveExplicitSelection(
	skills: CatalogSkill[],
	name: string,
	catalog: ReferenceCatalog,
	files: SkillFiles,
): Promise<ReadSelection | undefined> {
	const normalized = normalizedPath(name);
	for (const skill of skills) {
		if (normalized.toLowerCase() === `${skill.name}/skill.md`) {
			return { kind: "skill", skill };
		}
		const prefix = `${skill.name}/references/`;
		if (normalized.toLowerCase().startsWith(prefix)) {
			const requestedReference = normalized.slice(prefix.length);
			return (
				(await findReference(skill, requestedReference, catalog, files)) ??
				unknownReferenceForSkill(requestedReference, skill)
			);
		}
	}
	if (!isAbsolute(name)) return undefined;
	const requestedPath = await files.absolute(name);
	for (const skill of skills) {
		if (requestedPath === skill.path) return { kind: "skill", skill };
		const reference = await findReference(skill, requestedPath, catalog, files);
		if (reference) return reference;
	}
	return undefined;
}

async function resolvePrimarySelection(
	skills: CatalogSkill[],
	name: string,
	catalog: ReferenceCatalog,
	files: SkillFiles,
): Promise<ReadSelection> {
	const direct = findSkillByName(skills, name);
	if (direct) return { kind: "skill", skill: direct };
	const explicit = await resolveExplicitSelection(skills, name, catalog, files);
	if (explicit) return explicit;
	throw new Error(
		`Unknown skill "${name}". Available: ${skills.map((skill) => skill.name).join(", ") || "none"}`,
	);
}

async function resolveAdditionalSelection(
	skills: CatalogSkill[],
	name: string,
	selectedSkill: CatalogSkill,
	catalog: ReferenceCatalog,
	files: SkillFiles,
): Promise<ReadSelection> {
	const exactSkill = skills.find((skill) => skill.name === name);
	if (exactSkill) return { kind: "skill", skill: exactSkill };
	const explicit = await resolveExplicitSelection(skills, name, catalog, files);
	if (explicit) return explicit;
	const local = await findReference(selectedSkill, name, catalog, files);
	if (local) return local;
	const references: ReferenceSelection[] = [];
	for (const skill of skills) {
		const reference = await findReference(skill, name, catalog, files);
		if (reference) references.push(reference);
	}
	if (references.length === 1) return references[0] as ReferenceSelection;
	if (references.length > 1) {
		throw new Error(
			`Ambiguous reference "${name}". Use one of: ${references
				.map(
					(reference) =>
						`${reference.skill.name}/references/${reference.reference}`,
				)
				.join(", ")}`,
		);
	}
	throw new Error(
		`Unknown skill or reference "${name}". Use "list" for skill names or "read <skill>" to inspect reference paths`,
	);
}

function deduplicateSelections(selections: ReadSelection[]): ReadSelection[] {
	const seen = new Set<string>();
	return selections.filter((selection) => {
		const path =
			selection.kind === "skill" ? selection.skill.path : selection.path;
		if (seen.has(path)) return false;
		seen.add(path);
		return true;
	});
}

export async function selectSkillPackage(
	skills: CatalogSkill[],
	name: string,
	selectors: string[],
	files: SkillFiles,
): Promise<ReadSelection[]> {
	const catalog: ReferenceCatalog = new Map();
	const primary = await resolvePrimarySelection(skills, name, catalog, files);
	let selectedSkill = primary.skill;
	const additional: ReadSelection[] = [];
	for (const selector of selectors) {
		if (await isOwnSkillDocument(selector, selectedSkill, files)) continue;
		const selection = await resolveAdditionalSelection(
			skills,
			selector,
			selectedSkill,
			catalog,
			files,
		);
		additional.push(selection);
		if (selection.kind === "skill") selectedSkill = selection.skill;
	}
	const selections = deduplicateSelections(
		primary.kind === "skill" &&
			additional.length > 0 &&
			additional.every((selection) => selection.kind === "reference")
			? additional
			: [primary, ...additional],
	);
	return selections;
}
