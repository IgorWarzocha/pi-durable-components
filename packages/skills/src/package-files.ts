// Adapted from pi-better-skills-tool at b2006db9. MIT, Copyright (c) 2026 Igor Warzocha.
import type { CatalogSkill } from "./discovery.ts";
import { isWithin, relative, SkillFiles } from "./files.ts";

export async function packageFiles(
	skill: CatalogSkill,
	files: SkillFiles,
): Promise<string[]> {
	const root = await files.canonical(skill.directory);
	const paths: string[] = [];
	const visitedDirectories = new Set<string>();
	async function listAssetEntries(directory: string): Promise<void> {
		for (const entry of await files.entries(directory)) {
			const path = await files.join(directory, entry.name);
			if (!(await files.kind(entry, path))) continue;
			const realPath = await files.optionalCanonical(path);
			if (realPath && isWithin(root, realPath)) paths.push(path);
		}
	}
	async function visit(directory: string): Promise<void> {
		const realDirectory = await files.canonical(directory);
		if (!isWithin(root, realDirectory) || visitedDirectories.has(realDirectory))
			return;
		visitedDirectories.add(realDirectory);
		for (const entry of await files.entries(directory)) {
			const path = await files.join(directory, entry.name);
			const kind = await files.kind(entry, path);
			if (!kind) continue;
			const realPath = await files.optionalCanonical(path);
			if (!realPath || !isWithin(root, realPath)) continue;
			if (kind === "directory") {
				if (entry.name === "node_modules") continue;
				if (directory === skill.directory && entry.name === "assets")
					await listAssetEntries(path);
				else await visit(path);
			} else paths.push(path);
		}
	}
	await visit(skill.directory);
	return paths.sort((left, right) =>
		left === skill.path
			? -1
			: right === skill.path
				? 1
				: left.localeCompare(right),
	);
}

export async function referencePaths(
	skill: CatalogSkill,
	files: SkillFiles,
): Promise<Map<string, string>> {
	const root = await files.join(skill.directory, "references");
	const available = new Map<string, string>();
	for (const path of await packageFiles(skill, files)) {
		if (!isWithin(root, path) || !path.toLowerCase().endsWith(".md")) continue;
		const info = files.unwrap(
			await files.env.fileInfo(await files.canonical(path), files.context),
		);
		if (info.kind === "file")
			available.set(relative(root, path).replace(/\.md$/i, ""), path);
	}
	return available;
}
