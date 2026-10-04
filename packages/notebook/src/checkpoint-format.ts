// Adapted from pi-codex-conversion at b2006db9def12c373ae48e70044d30f7d6b7e34f, MIT. See ../NOTICE.
import { lstatSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import {
	MAX_PROJECT_ENTRIES,
	MAX_PROJECT_MANIFEST_BYTES,
	MAX_PROJECT_NAME_BYTES,
	type ProjectBindingMetadata,
	parseProjectBindingMetadata,
} from "./project-state-format.ts";

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const PAYLOAD_NAME = /^checkpoint-[0-9a-f-]+\.bin$/;

export const CHECKPOINT_SCHEMA = 1;

interface CheckpointEntry extends ProjectBindingMetadata {
	name: string;
	kind: "value" | "function";
	offset: number;
	length: number;
}

export interface CheckpointManifest {
	schema: number;
	project: string;
	projectGeneration?: string | undefined;
	projectNames?: string[] | undefined;
	session: string;
	deno: string;
	v8: string;
	payload: string;
	createdAt: string;
	entries: CheckpointEntry[];
	skipped: Array<{ name: string; reason: string }>;
}

export interface NotebookCheckpointIdentity {
	project: string;
	session: string;
	agentDir: string;
}

export function readCheckpointManifest(
	path: string,
): CheckpointManifest | undefined {
	try {
		const stat = lstatSync(path);
		if (
			!stat.isFile() ||
			stat.isSymbolicLink() ||
			stat.size > MAX_PROJECT_MANIFEST_BYTES
		)
			return undefined;
		const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!isRecord(value) || value["schema"] !== CHECKPOINT_SCHEMA)
			return undefined;
		if (
			typeof value["project"] !== "string" ||
			typeof value["session"] !== "string" ||
			typeof value["deno"] !== "string" ||
			typeof value["v8"] !== "string" ||
			typeof value["payload"] !== "string" ||
			typeof value["createdAt"] !== "string" ||
			!Array.isArray(value["entries"]) ||
			!Array.isArray(value["skipped"]) ||
			value["entries"].length > MAX_PROJECT_ENTRIES ||
			value["skipped"].length > MAX_PROJECT_ENTRIES ||
			("projectNames" in value &&
				(!Array.isArray(value["projectNames"]) ||
					value["projectNames"].length > MAX_PROJECT_ENTRIES ||
					!value["projectNames"].every(
						(name) =>
							typeof name === "string" &&
							IDENTIFIER.test(name) &&
							Buffer.byteLength(name) <= MAX_PROJECT_NAME_BYTES,
					))) ||
			!PAYLOAD_NAME.test(value["payload"]) ||
			basename(value["payload"]) !== value["payload"]
		)
			return undefined;
		const entries = value["entries"].map(parseEntry);
		const skipped = value["skipped"].map(parseSkipped);
		if (entries.some((entry) => !entry) || skipped.some((entry) => !entry))
			return undefined;
		return {
			schema: CHECKPOINT_SCHEMA,
			project: value["project"],
			session: value["session"],
			...(typeof value["projectGeneration"] === "string"
				? { projectGeneration: value["projectGeneration"] }
				: {}),
			...(Array.isArray(value["projectNames"])
				? { projectNames: value["projectNames"] as string[] }
				: {}),
			deno: value["deno"],
			v8: value["v8"],
			payload: value["payload"],
			createdAt: value["createdAt"],
			entries: entries as CheckpointEntry[],
			skipped: skipped as Array<{ name: string; reason: string }>,
		};
	} catch {
		return undefined;
	}
}

export function isValidCheckpointPayload(
	manifest: CheckpointManifest,
	path: string,
	maxBytes: number,
): boolean {
	try {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes)
			return false;
		let offset = 0;
		const names = new Set<string>();
		for (const entry of manifest.entries) {
			if (names.has(entry.name) || entry.offset !== offset) return false;
			names.add(entry.name);
			offset += entry.length;
		}
		return offset === stat.size;
	} catch {
		return false;
	}
}

function parseEntry(value: unknown): CheckpointEntry | undefined {
	if (!isRecord(value)) return undefined;
	const { name, offset, length, kind } = value;
	const metadata = parseProjectBindingMetadata(value);
	return typeof name === "string" &&
		IDENTIFIER.test(name) &&
		Buffer.byteLength(name) <= MAX_PROJECT_NAME_BYTES &&
		(kind === undefined || kind === "value" || kind === "function") &&
		Number.isSafeInteger(offset) &&
		(offset as number) >= 0 &&
		Number.isSafeInteger(length) &&
		(length as number) >= 0 &&
		metadata !== undefined
		? {
				name,
				kind: kind === "function" ? "function" : "value",
				offset: offset as number,
				length: length as number,
				...metadata,
			}
		: undefined;
}

function parseSkipped(
	value: unknown,
): { name: string; reason: string } | undefined {
	if (!isRecord(value)) return undefined;
	return typeof value["name"] === "string" &&
		Buffer.byteLength(value["name"]) <= MAX_PROJECT_NAME_BYTES &&
		typeof value["reason"] === "string" &&
		Buffer.byteLength(value["reason"]) <= MAX_PROJECT_NAME_BYTES
		? { name: value["name"], reason: value["reason"] }
		: undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
