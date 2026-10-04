// Adapted from pi-codex-conversion at b2006db9def12c373ae48e70044d30f7d6b7e34f, MIT. See ../NOTICE.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
	hashStateBytes,
	isRecord,
	MAX_PROJECT_ENTRIES,
	MAX_PROJECT_MANIFEST_BYTES,
	PROJECT_STATE_SCHEMA,
	type ProjectStateCandidate,
	type ProjectStateEntry,
	type ProjectStateManifest,
	parseEntry,
	parseSkipped,
} from "./project-state-format.ts";

const PAYLOAD_NAME = /^project-[0-9a-f-]+\.bin$/;
export function projectStatePaths(project: string, agentDir: string) {
	const key = createHash("sha256").update(resolve(project)).digest("hex");
	const directory = join(
		agentDir,
		"cache",
		"pi-durable-notebook",
		"projects",
		key,
	);
	return {
		directory,
		manifest: join(directory, "project.json"),
		lock: join(directory, "write.lock"),
	};
}

export function readProjectStateManifest(
	path: string,
): ProjectStateManifest | undefined {
	try {
		if (statSync(path).size > MAX_PROJECT_MANIFEST_BYTES) return undefined;
		const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!isRecord(value) || value["schema"] !== PROJECT_STATE_SCHEMA)
			return undefined;
		if (
			typeof value["project"] !== "string" ||
			typeof value["generation"] !== "string" ||
			typeof value["deno"] !== "string" ||
			typeof value["v8"] !== "string" ||
			typeof value["payload"] !== "string" ||
			typeof value["createdAt"] !== "string" ||
			!Number.isFinite(Date.parse(value["createdAt"])) ||
			typeof value["sourceSession"] !== "string" ||
			!Array.isArray(value["entries"]) ||
			!Array.isArray(value["skipped"]) ||
			!PAYLOAD_NAME.test(value["payload"]) ||
			basename(value["payload"]) !== value["payload"] ||
			value["entries"].length > MAX_PROJECT_ENTRIES ||
			value["skipped"].length > MAX_PROJECT_ENTRIES
		)
			return undefined;
		const entries = value["entries"].map((entry) =>
			parseEntry(entry, Number.MAX_SAFE_INTEGER, true),
		);
		const skipped = value["skipped"].map(parseSkipped);
		if (entries.some((entry) => !entry) || skipped.some((entry) => !entry))
			return undefined;
		return {
			schema: PROJECT_STATE_SCHEMA,
			project: value["project"],
			generation: value["generation"],
			...(typeof value["parentGeneration"] === "string"
				? { parentGeneration: value["parentGeneration"] }
				: {}),
			deno: value["deno"],
			v8: value["v8"],
			payload: value["payload"],
			createdAt: value["createdAt"],
			sourceSession: value["sourceSession"],
			entries: entries as ProjectStateEntry[],
			skipped: skipped as Array<{ name: string; reason: string }>,
		};
	} catch {
		return undefined;
	}
}

export function readProjectStateCandidate(
	manifestPath: string,
	payloadPath: string,
	maxBytes: number,
): ProjectStateCandidate | undefined {
	try {
		if (statSync(manifestPath).size > MAX_PROJECT_MANIFEST_BYTES)
			return undefined;
		const value = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
		if (
			!isRecord(value) ||
			typeof value["deno"] !== "string" ||
			typeof value["v8"] !== "string"
		)
			return undefined;
		if (!Array.isArray(value["entries"]) || !Array.isArray(value["skipped"]))
			return undefined;
		if (
			value["entries"].length > MAX_PROJECT_ENTRIES ||
			value["skipped"].length > MAX_PROJECT_ENTRIES
		)
			return undefined;
		const payloadLength = statSync(payloadPath).size;
		if (payloadLength > maxBytes) return undefined;
		const entries = value["entries"].map((entry) =>
			parseEntry(entry, payloadLength, false),
		);
		const skipped = value["skipped"].map(parseSkipped);
		if (entries.some((entry) => !entry) || skipped.some((entry) => !entry))
			return undefined;
		return {
			deno: value["deno"],
			v8: value["v8"],
			entries: entries as ProjectStateCandidate["entries"],
			skipped: skipped as ProjectStateCandidate["skipped"],
		};
	} catch {
		return undefined;
	}
}

export function readProjectStatePayload(
	manifest: ProjectStateManifest,
	path: string,
	maxBytes: number,
): Buffer | undefined {
	try {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes)
			return undefined;
		const payload = readFileSync(path);
		const names = new Set<string>();
		let offset = 0;
		for (const entry of manifest.entries) {
			if (
				names.has(entry.name) ||
				entry.offset !== offset ||
				entry.offset + entry.length > payload.length
			)
				return undefined;
			names.add(entry.name);
			if (
				hashStateBytes(
					payload.subarray(entry.offset, entry.offset + entry.length),
				) !== entry.hash
			)
				return undefined;
			offset += entry.length;
		}
		return offset === payload.length ? payload : undefined;
	} catch {
		return undefined;
	}
}
