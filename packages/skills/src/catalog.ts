// Adapted from pi-better-skills-tool at b2006db9. MIT, Copyright (c) 2026 Igor Warzocha.
import { Buffer } from "node:buffer";
import {
	type CatalogSkill,
	discoverVisibleSkills,
	type SkillsCatalogOptions,
} from "./discovery.ts";
import { SkillFiles } from "./files.ts";
import { readSkillPackage, type SkillReadOutput } from "./skill-package.ts";

const MAX_OUTPUT_BYTES = 48 * 1024;
// Leave room for an exact continuation command inside the output budget.
const MAX_COMMAND_BYTES = 4 * 1024;
const READ_HELP =
	"Reference-only selectors omit the initial skill body. To read a body plus references, use separate commands: read skill; read other/references/topic";

type SkillRequest =
	| { action: "help" }
	| { action: "list"; categories: string[] }
	| { action: "read"; name: string; selectors: string[] };

interface SkillsRequest {
	commands: SkillRequest[];
	offset: number;
}

export function parseRequest(input: unknown): SkillsRequest {
	if (input === undefined) input = "";
	if (typeof input !== "string")
		throw new Error("skills expects a string command");
	const offsetMatch = input.match(/\s+--offset\s+(\d+)\s*$/);
	const offset = offsetMatch ? Number(offsetMatch[1]) : 0;
	if (!Number.isSafeInteger(offset))
		throw new Error("--offset expects a non-negative safe integer byte offset");
	const command = offsetMatch ? input.slice(0, offsetMatch.index) : input;
	if (/(?:^|\s)--offset(?:\s|$)/.test(command))
		throw new Error("Use --offset <byte> once at the end of the command");
	const groups = command.split(";");
	if (groups.length > 1 && groups.some((group) => !group.trim()))
		throw new Error("Empty command group. Separate read/list commands with ;");
	const commands = groups.map(parseCommand);
	if (Buffer.byteLength(formatCommand(commands)) > MAX_COMMAND_BYTES)
		throw new Error(`skills command exceeds ${MAX_COMMAND_BYTES} bytes`);
	return { commands, offset };
}

function parseCommand(input: string): SkillRequest {
	const parts = input.trim().split(/\s+/).filter(Boolean);
	const [action, ...arguments_] = parts;
	if (!action || (action === "help" && arguments_.length === 0)) {
		return { action: "help" };
	}
	if (action === "list") {
		return { action: "list", categories: [...new Set(arguments_)] };
	}
	if (action === "read" && arguments_.length >= 1) {
		return {
			action,
			name: arguments_[0] ?? "",
			selectors: arguments_.slice(1),
		};
	}
	if (action === "read") {
		throw new Error(
			'read expects one skill name and optional skill or reference names: "read <exact-skill-name> [skill-or-reference...]"',
		);
	}
	throw new Error(
		'Expected "help", "list", "list <category>...", or "read <exact-skill-name> [skill-or-reference...]"',
	);
}

function formatCommand(commands: SkillRequest[]): string {
	return commands
		.map((group) =>
			group.action === "help"
				? "help"
				: group.action === "list"
					? ["list", ...group.categories].join(" ")
					: ["read", group.name, ...group.selectors].join(" "),
		)
		.join("; ");
}

function formatSkillList(
	skills: CatalogSkill[],
	requestedCategories: string[] = [],
): string {
	const availableCategories = [
		...new Set(skills.flatMap(({ category }) => (category ? [category] : []))),
	].sort();
	const unknown = requestedCategories.filter(
		(category) => !availableCategories.includes(category),
	);
	if (unknown.length) {
		throw new Error(
			"Unknown categor" +
				(unknown.length === 1 ? "y" : "ies") +
				": " +
				unknown.join(", ") +
				". Available: " +
				(availableCategories.join(", ") || "none"),
		);
	}
	const selected = requestedCategories.length
		? skills.filter(({ category }) =>
				requestedCategories.includes(category ?? ""),
			)
		: skills;
	if (!selected.length) return "No skills available.";

	const topLevel = selected.filter(({ category }) => !category);
	const groups = new Map<string, CatalogSkill[]>();
	for (const skill of selected) {
		if (!skill.category) continue;
		const group = groups.get(skill.category) ?? [];
		group.push(skill);
		groups.set(skill.category, group);
	}
	const lines = topLevel.map(
		(skill) =>
			`- ${skill.name}: ${skill.description.replace(/\s+/g, " ").trim()}`,
	);
	if (topLevel.length && groups.size) lines.push("");
	for (const [category, categorySkills] of groups) {
		lines.push(`# ${category.replace(/-/g, " ").toUpperCase()}`);
		for (const skill of categorySkills) {
			lines.push(
				`- ${skill.name}: ${skill.description.replace(/\s+/g, " ").trim()}`,
			);
		}
	}
	return lines.join("\n");
}

function boundedOutput(result: SkillReadOutput, request: SkillsRequest) {
	const { output, reads } = result;
	const bytes = Buffer.from(output);
	const { offset } = request;
	if (offset > bytes.length || (offset > 0 && offset === bytes.length))
		throw new Error(
			`--offset ${offset} is outside output (${bytes.length} bytes)`,
		);
	if (offset < bytes.length && ((bytes[offset] ?? 0) & 0xc0) === 0x80)
		throw new Error(`--offset ${offset} splits a UTF-8 character`);
	const page = (output: string, end: number) => ({
		output,
		skillReads: {
			version: 1 as const,
			// Labels, inventories and footers do not expose instruction bodies.
			reads: reads
				.filter(
					(span) =>
						span.start < span.end && span.start < end && span.end > offset,
				)
				.map(({ read }) => read),
			continuation: offset > 0,
		},
	});
	if (bytes.length - offset <= MAX_OUTPUT_BYTES)
		return page(
			offset === 0 ? output : bytes.subarray(offset).toString("utf8"),
			bytes.length,
		);
	const command = formatCommand(request.commands);
	const footer = (end: number) =>
		`\n\n---\nIncomplete: bytes ${offset}-${end} of ${bytes.length}. Continue with command:\n${command} --offset ${end}`;
	let end = offset + MAX_OUTPUT_BYTES - Buffer.byteLength(footer(bytes.length));
	while (((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
	return page(bytes.subarray(offset, end).toString("utf8") + footer(end), end);
}

/** Text-only public helper retained for existing consumers. Tool results also carry read evidence. */
export async function runSkills(
	input: unknown,
	files: SkillFiles,
	options: SkillsCatalogOptions,
): Promise<string> {
	return (await runSkillsResult(input, files, options)).output;
}

export async function runSkillsResult(
	input: unknown,
	files: SkillFiles,
	options: SkillsCatalogOptions,
) {
	const request = parseRequest(input);
	const skills = await discoverVisibleSkills(files, options);
	const result: SkillReadOutput = { output: "", reads: [] };
	for (const [index, command] of request.commands.entries()) {
		files.check();
		if (index) result.output += "\n\n";
		if (command.action === "read") {
			const selected = await readSkillPackage(
				skills,
				command.name,
				command.selectors,
				files,
			);
			const start = Buffer.byteLength(result.output);
			result.output += selected.output;
			result.reads.push(
				...selected.reads.map((span) => ({
					read: span.read,
					start: start + span.start,
					end: start + span.end,
				})),
			);
		} else {
			result.output +=
				command.action === "help"
					? `list [category...] | read <skill> [skill-or-reference...] | help\nJS: tools.skills("read <skill>")\nBatch: read skill-a skill-b; semicolons separate full commands: read skill-a; read skill-b\n${READ_HELP}\n\n${formatSkillList(skills)}`
					: `${READ_HELP}\n\n${formatSkillList(skills, command.categories)}`;
		}
	}
	return boundedOutput(result, request);
}
