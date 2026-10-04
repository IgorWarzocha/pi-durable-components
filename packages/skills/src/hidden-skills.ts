// Follows the hidden-skill prepass used by pi-better-skills-tool at b2006db9.
// Ignore/frontmatter policy follows @earendil-works/pi-coding-agent 1.0.1. See NOTICE.
import ignore, { type Ignore } from "ignore";
import { parse } from "yaml";
import { relative, SkillFiles } from "./files.ts";

export interface HiddenSkills {
	paths: Set<string>;
	names: Set<string>;
}

function prefixIgnorePattern(line: string, prefix: string): string | undefined {
	const trimmed = line.trim();
	if (!trimmed || (trimmed.startsWith("#") && !trimmed.startsWith("\\#")))
		return undefined;
	let pattern = line;
	let negated = false;
	if (pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1);
	} else if (pattern.startsWith("\\!")) pattern = pattern.slice(1);
	if (pattern.startsWith("/")) pattern = pattern.slice(1);
	const prefixed = `${prefix}${pattern}`;
	return negated ? `!${prefixed}` : prefixed;
}

async function addIgnoreRules(
	files: SkillFiles,
	matcher: Ignore,
	directory: string,
	root: string,
): Promise<void> {
	const relativeDirectory = relative(root, directory);
	const prefix = relativeDirectory ? `${relativeDirectory}/` : "";
	for (const filename of [".gitignore", ".ignore", ".fdignore"]) {
		const path = await files.join(directory, filename);
		if (!(await files.exists(path))) continue;
		const patterns = (await files.text(path))
			.split(/\r?\n/)
			.map((line) => prefixIgnorePattern(line, prefix))
			.filter((pattern): pattern is string => pattern !== undefined);
		matcher.add(patterns);
	}
}

function hiddenName(content: string, directory: string): string | undefined {
	// Pi's loader uses a separate YAML parser for metadata, not the tool's document parser.
	// Invalid YAML is a loader warning and contributes no hidden paths or names.
	const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
	if (!normalized.startsWith("---")) return undefined;
	const end = normalized.indexOf("\n---", 3);
	if (end === -1) return undefined;
	let fields: unknown;
	try {
		fields = parse(normalized.slice(4, end));
	} catch {
		return undefined;
	}
	if (
		typeof fields !== "object" ||
		fields === null ||
		!("description" in fields) ||
		typeof fields.description !== "string" ||
		!fields.description.trim() ||
		!("disable-model-invocation" in fields) ||
		fields["disable-model-invocation"] !== true
	)
		return undefined;
	const name =
		"name" in fields && typeof fields.name === "string"
			? fields.name
			: undefined;
	return (
		name || directory.replaceAll("\\", "/").split("/").filter(Boolean).at(-1)
	);
}

/** Reproduce only the loader policy the source tool consumes: disabled paths and hidden names. */
export async function discoverHiddenSkills(
	files: SkillFiles,
	root: string,
): Promise<HiddenSkills> {
	const hidden: HiddenSkills = { paths: new Set(), names: new Set() };
	const matcher = ignore();
	const ancestors = new Set<string>();
	async function load(path: string, directory: string): Promise<void> {
		const name = hiddenName(await files.text(path), directory);
		if (name !== undefined) {
			hidden.paths.add(path);
			hidden.names.add(name);
		}
	}
	async function visit(directory: string, rootFiles: boolean): Promise<void> {
		const canonical = await files.canonical(directory);
		if (ancestors.has(canonical)) return;
		ancestors.add(canonical);
		try {
			await addIgnoreRules(files, matcher, directory, root);
			const entries = await files.entries(directory);
			const declared = entries.find((entry) => entry.name === "SKILL.md");
			if (declared) {
				const path = await files.join(directory, declared.name);
				if (
					(await files.kind(declared, path)) === "file" &&
					!matcher.ignores(relative(root, path))
				) {
					await load(path, directory);
					return;
				}
			}
			for (const entry of entries) {
				if (entry.name === "node_modules") continue;
				const path = await files.join(directory, entry.name);
				const kind = await files.kind(entry, path);
				if (
					!kind ||
					matcher.ignores(
						`${relative(root, path)}${kind === "directory" ? "/" : ""}`,
					)
				)
					continue;
				if (kind === "directory") await visit(path, false);
				else if (rootFiles && entry.name.endsWith(".md"))
					await load(path, directory);
			}
		} finally {
			ancestors.delete(canonical);
		}
	}
	await visit(root, true);
	return hidden;
}
