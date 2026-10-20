import type { PulseBinding, PulseSource } from "./contract.ts";
import { parsePulseFrontmatter } from "./frontmatter.ts";
import {
	type PulseQuietHours,
	type PulseSchedule,
	parsePulseQuietHours,
	parsePulseSchedule,
} from "./schedule.ts";

type PulsePaths = {
	id: string;
	bindingKey: string;
	root: string;
	pulseHome: string;
	path: string;
};
export type PulseDefinition = PulsePaths & {
	status: "valid";
	title: string;
	scheduleText: string;
	schedule: PulseSchedule;
	enabled: boolean;
	target?: "child" | "resident";
	expiresAt?: number;
	quietHours?: PulseQuietHours;
	body: string;
};
export type PulseCatalogItem =
	| PulseDefinition
	| (PulsePaths & { status: "invalid"; title: string; error: string });

export function parsePulseDefinition(
	binding: PulseBinding,
	source: PulseSource,
): PulseCatalogItem {
	const pulseHome = `${binding.root.replace(/\/$/u, "")}/pulses/${source.id}`;
	const paths = {
		id: source.id,
		bindingKey: binding.key,
		root: binding.root,
		pulseHome,
		path: `${pulseHome}/PULSE.md`,
	};
	const invalid = (error: string): PulseCatalogItem => ({
		...paths,
		status: "invalid",
		title: `Invalid pulse: ${source.id}`,
		error,
	});
	if (!/^[a-z0-9][a-z0-9-]*$/u.test(source.id))
		return invalid("pulse folder name must be kebab-case");
	if (source.error !== undefined) return invalid(source.error);
	if (!source.text.trim()) return invalid("PULSE.md is empty");
	const { data, body } = parsePulseFrontmatter(source.text);
	if (!(typeof data["title"] === "string" && data["title"].trim()))
		return invalid("frontmatter must include title");
	const trigger = data["trigger"];
	if (trigger !== undefined && trigger !== "manual" && trigger !== "time")
		return invalid(`unsupported trigger: ${trigger}`);
	const scheduleText =
		trigger === "manual"
			? "manual"
			: typeof data["schedule"] === "string"
				? data["schedule"].trim()
				: "";
	const schedule = parsePulseSchedule(scheduleText);
	if (!schedule)
		return invalid(
			scheduleText
				? `invalid schedule: ${scheduleText}`
				: "frontmatter must include schedule",
		);
	const rawQuiet = data["quietHours"];
	const target = data["target"];
	if (target !== undefined && target !== "child" && target !== "resident")
		return invalid("target must be child or resident");
	const rawExpiry = data["expiresAt"];
	const expiresAt = typeof rawExpiry === "string" ? Date.parse(rawExpiry) : NaN;
	if (rawExpiry !== undefined && !Number.isFinite(expiresAt))
		return invalid("expiresAt must be a datetime");
	const quietHours =
		typeof rawQuiet === "string" ? parsePulseQuietHours(rawQuiet) : undefined;
	if (rawQuiet !== undefined && !quietHours)
		return invalid("quietHours must use HH:MM-HH:MM");
	return {
		...paths,
		status: "valid",
		title: data["title"].trim(),
		scheduleText,
		schedule,
		enabled: data["enabled"] !== false,
		...(target === undefined ? {} : { target }),
		...(rawExpiry === undefined ? {} : { expiresAt }),
		body,
		...(quietHours ? { quietHours } : {}),
	};
}
