// Adapted from pi-codex-conversion at b2006db9def12c373ae48e70044d30f7d6b7e34f, MIT. See ../NOTICE.
import { randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import {
	isRecord,
	MAX_PROJECT_ENTRIES,
	MAX_PROJECT_MANIFEST_BYTES,
	MAX_PROJECT_NAME_BYTES,
	PROJECT_STATE_SCHEMA,
	type ProjectConflictRecord,
} from "./project-state-format.ts";

import type { ProjectStateMerge } from "./project-state-merge.ts";

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const CONFLICT_PAYLOAD_NAME = /^[0-9]+-[0-9a-f-]+\.bin$/;
function readProjectConflictRecord(
	path: string,
): ProjectConflictRecord | undefined {
	try {
		const stat = lstatSync(path);
		if (
			!stat.isFile() ||
			stat.isSymbolicLink() ||
			stat.size > MAX_PROJECT_MANIFEST_BYTES
		)
			return undefined;
		const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!isRecord(value) || value["schema"] !== PROJECT_STATE_SCHEMA)
			return undefined;
		if (!Array.isArray(value["entries"]) || !Array.isArray(value["deletions"]))
			return undefined;
		if (
			value["entries"].length > MAX_PROJECT_ENTRIES ||
			value["deletions"].length > MAX_PROJECT_ENTRIES
		)
			return undefined;
		const names = [
			...value["entries"].map((entry) =>
				isRecord(entry) ? entry["name"] : undefined,
			),
			...value["deletions"],
		];
		if (
			names.some(
				(name) =>
					typeof name !== "string" ||
					!IDENTIFIER.test(name) ||
					Buffer.byteLength(name) > MAX_PROJECT_NAME_BYTES,
			)
		) {
			return undefined;
		}
		const payload = value["payload"];
		const recordId = basename(path, ".json");
		if (
			payload !== undefined &&
			(typeof payload !== "string" ||
				!CONFLICT_PAYLOAD_NAME.test(payload) ||
				basename(payload) !== payload ||
				payload !== `${recordId}.bin`)
		)
			return undefined;
		return {
			names: [...new Set(names as string[])],
			...(typeof payload === "string" ? { payload } : {}),
		};
	} catch {
		return undefined;
	}
}

export function writeProjectConflict(
	directory: string,
	identity: { project: string; session: string },
	merged: ProjectStateMerge,
): void {
	const conflicts = join(directory, "conflicts");
	mkdirSync(conflicts, { recursive: true });
	for (const entry of merged.conflictEntries) {
		const id = `${Date.now()}-${randomUUID()}`;
		const payload = `${id}.bin`;
		const bytes = merged.conflictPayload.subarray(
			entry.offset,
			entry.offset + entry.length,
		);
		writeFileSync(join(conflicts, payload), bytes, { mode: 0o600 });
		writeFileSync(
			join(conflicts, `${id}.json`),
			`${JSON.stringify(
				{
					schema: PROJECT_STATE_SCHEMA,
					project: resolve(identity.project),
					session: identity.session,
					createdAt: new Date().toISOString(),
					payload,
					entries: [{ ...entry, offset: 0 }],
					deletions: [],
				},
				null,
				2,
			)}\n`,
			{ mode: 0o600 },
		);
	}
	for (const name of merged.conflictDeletions) {
		const id = `${Date.now()}-${randomUUID()}`;
		writeFileSync(
			join(conflicts, `${id}.json`),
			`${JSON.stringify(
				{
					schema: PROJECT_STATE_SCHEMA,
					project: resolve(identity.project),
					session: identity.session,
					createdAt: new Date().toISOString(),
					entries: [],
					deletions: [name],
				},
				null,
				2,
			)}\n`,
			{ mode: 0o600 },
		);
	}
}

export function listProjectConflicts(directory: string): string[] {
	const names = new Set<string>();
	for (const file of readDirectoryNames(join(directory, "conflicts"))) {
		if (!file.endsWith(".json")) continue;
		const record = readProjectConflictRecord(
			join(directory, "conflicts", file),
		);
		for (const name of record?.names ?? []) names.add(name);
	}
	return [...names].sort();
}

export function removeResolvedProjectConflicts(
	directory: string,
	names: ReadonlySet<string>,
): void {
	if (names.size === 0) return;
	const conflicts = join(directory, "conflicts");
	for (const file of readDirectoryNames(conflicts)) {
		if (!file.endsWith(".json")) continue;
		const path = join(conflicts, file);
		try {
			const record = readProjectConflictRecord(path);
			if (!record || !record.names.some((name) => names.has(name))) continue;
			if (record.payload)
				rmSync(join(conflicts, record.payload), { force: true });
			rmSync(path, { force: true });
		} catch {}
	}
}

function readDirectoryNames(directory: string): string[] {
	if (!existsSync(directory)) return [];
	try {
		return readdirSync(directory);
	} catch {
		return [];
	}
}
