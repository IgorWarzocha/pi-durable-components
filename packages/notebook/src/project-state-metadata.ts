// Adapted from pi-codex-conversion at b2006db9def12c373ae48e70044d30f7d6b7e34f, MIT. See ../NOTICE.
const MAX_NOTICE_NAMES = 24;

import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	projectStatePaths,
	readProjectStateManifest,
	readProjectStatePayload,
} from "./project-state-files.ts";
import {
	type ProjectStateEntry,
	type ProjectStateSummary,
} from "./project-state-format.ts";

export interface RetainedProjectBinding {
	name: string;
	kind: ProjectStateEntry["kind"];
	bytes: number;
	updatedAt: string;
	pinned: boolean;
	hook?: ProjectStateEntry["hook"];
	description?: string | undefined;
	usage?: string | undefined;
}

export function readRetainedProjectBindings(
	identity: {
		project: string;
		agentDir: string;
	},
	maxBytes: number,
): RetainedProjectBinding[] {
	const paths = projectStatePaths(identity.project, identity.agentDir);
	const manifest = readProjectStateManifest(paths.manifest);
	if (!manifest || manifest.project !== resolve(identity.project)) return [];
	if (
		!hasPayloadLayout(
			manifest.entries,
			join(paths.directory, manifest.payload),
			maxBytes,
		)
	)
		return [];
	return manifest.entries.map((entry) => ({
		name: entry.name,
		kind: entry.kind,
		bytes: entry.length,
		updatedAt: entry.updatedAt ?? manifest.createdAt,
		pinned: entry.pinned === true,
		...(entry.hook ? { hook: entry.hook } : {}),
		...(entry.description === undefined
			? {}
			: { description: entry.description }),
		...(entry.usage === undefined ? {} : { usage: entry.usage }),
	}));
}

function hasPayloadLayout(
	entries: ProjectStateEntry[],
	path: string,
	maxBytes: number,
): boolean {
	try {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes)
			return false;
		let offset = 0;
		const names = new Set<string>();
		for (const entry of entries) {
			if (names.has(entry.name) || entry.offset !== offset) return false;
			names.add(entry.name);
			offset += entry.length;
		}
		return offset === stat.size;
	} catch {
		return false;
	}
}

export function projectStateBindingNames(
	identity: { project: string; agentDir: string },
	maxBytes: number,
): string[] {
	const paths = projectStatePaths(identity.project, identity.agentDir);
	const manifest = readProjectStateManifest(paths.manifest);
	return manifest?.project === resolve(identity.project) &&
		readProjectStatePayload(
			manifest,
			join(paths.directory, manifest.payload),
			maxBytes,
		)
		? manifest.entries.map(({ name }) => name)
		: [];
}

export function formatProjectStateNotice(
	summary: ProjectStateSummary,
): string | undefined {
	if (summary.message) return summary.message;
	const values = summary.restored.filter(({ kind }) => kind === "value").length;
	const definitions = summary.restored.length - values;
	const restored =
		summary.restored.length > 0
			? `Project notebook restored ${values} value${values === 1 ? "" : "s"} and ${definitions} definition${definitions === 1 ? "" : "s"}`
			: undefined;
	const conflicts =
		summary.conflicts.length > 0
			? `Project notebook conflicts preserved without overwrite: ${formatNameList(summary.conflicts)}`
			: undefined;
	return [restored, conflicts].filter(Boolean).join(". ") || undefined;
}

function formatNameList(names: string[]): string {
	const shown = names.slice(0, MAX_NOTICE_NAMES).join(", ");
	return names.length > MAX_NOTICE_NAMES
		? `${shown}, and ${names.length - MAX_NOTICE_NAMES} more`
		: shown;
}
