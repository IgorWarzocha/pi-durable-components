/** Host-resolved CatalogSkill metadata. Bodies are acquired only when selected. */
export interface SkillCatalogItem {
	name: string;
	description: string;
	packageName: string;
	category: string | null;
	directory: string;
	path: string;
}
export interface SkillsPresentationState {
	skills: SkillCatalogItem[];
	detail: (SkillCatalogItem & { body: string }) | null;
}

function object(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new TypeError("Expected an object");
	return Object.fromEntries(Object.entries(value));
}
function string(value: unknown): string {
	if (typeof value !== "string") throw new TypeError("Expected a string");
	return value;
}
function array<T>(value: unknown, parse: (item: unknown) => T): T[] {
	if (!Array.isArray(value)) throw new TypeError("Expected an array");
	return value.map(parse);
}

function parseSkill(value: unknown): SkillCatalogItem {
	const item = object(value);
	const name = string(item["name"]);
	const description = string(item["description"]);
	if (
		!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ||
		name.length > 64 ||
		!description.trim() ||
		description.length > 1024
	)
		throw new TypeError("Invalid skill metadata");
	return {
		name,
		description,
		packageName: string(item["packageName"]),
		category: item["category"] === null ? null : string(item["category"]),
		directory: string(item["directory"]),
		path: string(item["path"]),
	};
}
export function parseSkillsPresentationState(
	value: unknown,
): SkillsPresentationState {
	const state = object(value);
	const skills = array(state["skills"], parseSkill);
	let detail: SkillsPresentationState["detail"] = null;
	if (state["detail"] !== null) {
		const item = object(state["detail"]);
		const body = string(item["body"]);
		if (!body.trim()) throw new TypeError("Expected skill instructions");
		detail = { ...parseSkill(item), body };
		const metadata = skills.find((skill) => skill.name === detail?.name);
		if (
			!metadata ||
			metadata.path !== detail.path ||
			metadata.directory !== detail.directory ||
			metadata.packageName !== detail.packageName ||
			metadata.category !== detail.category ||
			metadata.description !== detail.description
		)
			throw new TypeError("Skill detail does not match the catalog");
	}
	return { skills, detail };
}
export const skillsCapability = {
	id: "skills",
	version: 1,
	parseState: parseSkillsPresentationState,
	actions: ["skills"],
	streams: [],
	presentations: ["skills.summary", "skills.detail"],
};
export const skillsSummaryPresentation = {
	id: "skills.summary",
	requests: ["skills.detail"],
	select(state: SkillsPresentationState) {
		return {
			count: state.skills.length,
			categories: [
				...new Set(
					state.skills.flatMap((skill) =>
						skill.category === null ? [] : [skill.category],
					),
				),
			],
			skills: state.skills,
		};
	},
};
export const skillsDetailPresentation = {
	id: "skills.detail",
	requests: [],
	select: (state: SkillsPresentationState) => state.detail,
};
