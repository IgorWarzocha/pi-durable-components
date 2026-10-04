// Adapted from pi-codex-conversion at b2006db9def12c373ae48e70044d30f7d6b7e34f, MIT. See ../NOTICE.
import { createHash } from "node:crypto";
import type { NotebookHook } from "./runtime-contract.ts";

export const PROJECT_STATE_SCHEMA = 2;
export const MAX_PROJECT_ENTRIES = 10_000;
export const MAX_PROJECT_NAME_BYTES = 4 * 1024;
export const MAX_PROJECT_MANIFEST_BYTES = 8 * 1024 * 1024;
export const MAX_PROJECT_DESCRIPTION_BYTES = 256;
export const MAX_PROJECT_USAGE_BYTES = 512;
export const MAX_PROJECT_USAGE_LINES = 4;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export interface ProjectStateEntry {
	name: string;
	kind: "value" | "function";
	offset: number;
	length: number;
	hash: string;
	description?: string | undefined;
	usage?: string | undefined;
	updatedAt?: string | undefined;
	pinned?: true | undefined;
	hook?: NotebookHook | undefined;
}

export interface ProjectBindingMetadata {
	description?: string | undefined;
	usage?: string | undefined;
}

export interface ProjectStateManifest {
	schema: number;
	project: string;
	generation: string;
	parentGeneration?: string | undefined;
	deno: string;
	v8: string;
	payload: string;
	createdAt: string;
	sourceSession: string;
	entries: ProjectStateEntry[];
	skipped: Array<{ name: string; reason: string }>;
}

export interface ProjectStateCandidate {
	deno: string;
	v8: string;
	entries: Array<Omit<ProjectStateEntry, "hash">>;
	skipped: Array<{ name: string; reason: string }>;
}

export interface ProjectStateBaseline {
	generation: string;
	entries: Array<{ name: string; hash: string } & ProjectBindingMetadata>;
}

export interface ProjectStateSummary {
	baseline: ProjectStateBaseline;
	restored: ProjectStateEntry[];
	skipped: Array<{ name: string; reason: string }>;
	conflicts: string[];
	message?: string | undefined;
}

export interface ProjectConflictRecord {
	names: string[];
	payload?: string | undefined;
}

export function baselineFromProjectManifest(
	manifest: ProjectStateManifest,
): ProjectStateBaseline {
	return {
		generation: manifest.generation,
		entries: manifest.entries.map(({ name, hash, description, usage }) => ({
			name,
			hash,
			...(description === undefined ? {} : { description }),
			...(usage === undefined ? {} : { usage }),
		})),
	};
}

export function emptyProjectStateSummary(): ProjectStateSummary {
	return {
		baseline: { generation: "root", entries: [] },
		restored: [],
		skipped: [],
		conflicts: [],
	};
}

export function hashStateBytes(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function parseEntry(
	value: unknown,
	payloadLength: number,
	requireHash: boolean,
): ProjectStateEntry | Omit<ProjectStateEntry, "hash"> | undefined {
	if (!isRecord(value)) return undefined;
	const { name, kind, offset, length, hash, updatedAt, pinned, hook } = value;
	if (
		typeof name !== "string" ||
		!IDENTIFIER.test(name) ||
		Buffer.byteLength(name) > MAX_PROJECT_NAME_BYTES ||
		(kind !== "value" && kind !== "function") ||
		!Number.isSafeInteger(offset) ||
		(offset as number) < 0 ||
		!Number.isSafeInteger(length) ||
		(length as number) < 0 ||
		(offset as number) + (length as number) > payloadLength ||
		(requireHash && typeof hash !== "string") ||
		(updatedAt !== undefined &&
			(typeof updatedAt !== "string" ||
				!Number.isFinite(Date.parse(updatedAt)))) ||
		(pinned !== undefined && pinned !== true) ||
		(hook !== undefined &&
			((hook !== "startup" && hook !== "tool_result") ||
				pinned !== true ||
				kind !== "function" ||
				!requireHash))
	)
		return undefined;
	const metadata = parseProjectBindingMetadata(value);
	if (!metadata) return undefined;
	const entry: Omit<ProjectStateEntry, "hash"> = {
		name,
		kind: kind as ProjectStateEntry["kind"],
		offset: offset as number,
		length: length as number,
		...metadata,
		...(typeof updatedAt === "string" ? { updatedAt } : {}),
		...(pinned === true ? { pinned: true as const } : {}),
		...(hook === "startup" || hook === "tool_result" ? { hook } : {}),
	};
	return requireHash ? { ...entry, hash: hash as string } : entry;
}

export function parseProjectBindingMetadata(
	value: Record<string, unknown>,
): ProjectBindingMetadata | undefined {
	const description = parseMetadataText(
		value["description"],
		MAX_PROJECT_DESCRIPTION_BYTES,
		false,
	);
	const usage = parseMetadataText(
		value["usage"],
		MAX_PROJECT_USAGE_BYTES,
		true,
	);
	if (description === null || usage === null) return undefined;
	return {
		...(description === undefined ? {} : { description }),
		...(usage === undefined ? {} : { usage }),
	};
}

function parseMetadataText(
	value: unknown,
	maxBytes: number,
	multiline: boolean,
): string | undefined | null {
	if (value === undefined) return undefined;
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		Buffer.byteLength(value) > maxBytes
	)
		return null;
	const lines = value.split("\n");
	if (
		(!multiline && lines.length !== 1) ||
		lines.length > MAX_PROJECT_USAGE_LINES ||
		value.includes("\r")
	)
		return null;
	for (const character of value) {
		const codePoint = character.codePointAt(0)!;
		if ((codePoint < 0x20 && codePoint !== 0x0a) || codePoint === 0x7f)
			return null;
	}
	return value;
}

export function parseSkipped(
	value: unknown,
): { name: string; reason: string } | undefined {
	return isRecord(value) &&
		typeof value["name"] === "string" &&
		Buffer.byteLength(value["name"]) <= MAX_PROJECT_NAME_BYTES &&
		typeof value["reason"] === "string"
		? { name: value["name"], reason: value["reason"] }
		: undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
