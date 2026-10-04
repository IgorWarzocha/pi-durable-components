// Adapted from pi-better-skills-tool at b2006db9. MIT, Copyright (c) 2026 Igor Warzocha.
import { isWithin, relative, SkillFiles } from "./files.ts";
import { discoverHiddenSkills } from "./hidden-skills.ts";
import { parseSkillDocument, validateSkill } from "./skill-document.ts";

export interface LoadedSkill {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	disableModelInvocation?: boolean;
	sourceInfo?: { scope?: string };
}

export interface SkillsCatalogOptions {
	/** Paths are resolved by the calling conversation's environment. No implicit global root. */
	globalRoot?: string;
	sessionRoot?: string;
	/** A nonempty host-resolved catalog is authoritative, including package and project skills. */
	loadedSkills?: readonly LoadedSkill[];
}

export interface CatalogSkill {
	name: string;
	description: string;
	packageName: string;
	category: string | undefined;
	directory: string;
	path: string;
	body: string;
}

interface DirectoryCatalog {
	skills: CatalogSkill[];
	hiddenNames: Set<string>;
}

async function loadSkill(
	files: SkillFiles,
	directory: string,
	packageName: string,
	category: string | undefined,
	hiddenPaths: ReadonlySet<string>,
): Promise<CatalogSkill | null | undefined> {
	const path = await files.join(directory, "SKILL.md");
	if (!(await files.exists(path))) return undefined;
	if (hiddenPaths.has(path)) return null;
	const content = await files.text(path);
	const document = parseSkillDocument(content, packageName);
	const skill: CatalogSkill = {
		name: document.frontmatter.name || packageName.split("/").at(-1) || "",
		description: document.frontmatter.description ?? "",
		packageName,
		category,
		directory,
		path,
		body: document.body,
	};
	validateSkill(skill);
	return skill;
}

function categoryRank(category: string | undefined): number {
	return !category ? 0 : category === "session" ? 1 : 2;
}
function sortSkills(skills: CatalogSkill[]): CatalogSkill[] {
	return skills.sort(
		(a, b) =>
			categoryRank(a.category) - categoryRank(b.category) ||
			(a.category ?? "").localeCompare(b.category ?? "") ||
			a.name.localeCompare(b.name),
	);
}

async function discoverDirectoryCatalog(
	files: SkillFiles,
	root: string,
): Promise<DirectoryCatalog> {
	if (!(await files.exists(root)))
		return { skills: [], hiddenNames: new Set() };
	const hidden = await discoverHiddenSkills(files, root);
	const skills: CatalogSkill[] = [];
	for (const entry of await files.entries(root)) {
		const directory = await files.join(root, entry.name);
		if ((await files.kind(entry, directory)) !== "directory") continue;
		const direct = await loadSkill(
			files,
			directory,
			entry.name,
			undefined,
			hidden.paths,
		);
		if (direct !== undefined) {
			if (direct) skills.push(direct);
			continue;
		}
		if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name))
			throw new Error(
				`${entry.name}: category names must contain only lowercase letters, numbers, and single hyphens`,
			);
		for (const child of await files.entries(directory)) {
			const childDirectory = await files.join(directory, child.name);
			if ((await files.kind(child, childDirectory)) !== "directory") continue;
			const skill = await loadSkill(
				files,
				childDirectory,
				`${entry.name}/${child.name}`,
				entry.name,
				hidden.paths,
			);
			if (skill) skills.push(skill);
		}
	}
	const names = new Map<string, string>();
	for (const skill of skills) {
		const existing = names.get(skill.name);
		if (existing)
			throw new Error(
				`Duplicate skill name "${skill.name}" in packages ${existing} and ${skill.packageName}`,
			);
		names.set(skill.name, skill.packageName);
	}
	return { skills: sortSkills(skills), hiddenNames: hidden.names };
}

export async function discoverSkills(
	files: SkillFiles,
	root: string,
): Promise<CatalogSkill[]> {
	return (await discoverDirectoryCatalog(files, await files.absolute(root)))
		.skills;
}

export async function discoverVisibleSkills(
	files: SkillFiles,
	options: SkillsCatalogOptions,
): Promise<CatalogSkill[]> {
	const globalRoot =
		options.globalRoot === undefined
			? undefined
			: await files.absolute(options.globalRoot);
	const sessionRoot =
		options.sessionRoot === undefined
			? undefined
			: await files.absolute(options.sessionRoot);
	if (options.loadedSkills?.length) {
		const skills: CatalogSkill[] = [];
		for (const loaded of options.loadedSkills) {
			if (loaded.disableModelInvocation) continue;
			const directory = await files.absolute(loaded.baseDir);
			const path = await files.absolute(loaded.filePath);
			let category: string | undefined;
			if (
				(sessionRoot && isWithin(sessionRoot, directory)) ||
				loaded.sourceInfo?.scope === "project"
			)
				category = "session";
			else if (globalRoot && isWithin(globalRoot, directory)) {
				const [first, nested] = relative(globalRoot, directory).split("/");
				if (first && nested) category = first;
			}
			const skill: CatalogSkill = {
				name: loaded.name,
				description: loaded.description,
				packageName: loaded.name,
				category,
				directory,
				path,
				body: parseSkillDocument(await files.text(path), loaded.name).body,
			};
			validateSkill(skill);
			skills.push(skill);
		}
		return sortSkills(skills);
	}
	const global = globalRoot
		? await discoverDirectoryCatalog(files, globalRoot)
		: { skills: [], hiddenNames: new Set<string>() };
	const byName = new Map(global.skills.map((skill) => [skill.name, skill]));
	if (sessionRoot) {
		const session = await discoverDirectoryCatalog(files, sessionRoot);
		for (const name of session.hiddenNames) byName.delete(name);
		for (const skill of session.skills)
			byName.set(skill.name, { ...skill, category: "session" });
	}
	return sortSkills([...byName.values()]);
}
