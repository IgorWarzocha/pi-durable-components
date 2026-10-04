// Adapted from pi-codex-conversion, Copyright (c) 2026 Igor Warzocha, MIT.
import { requiredString } from "./tool-contract.ts";

const NOTES_ROOT = "/notes";

export function normalizeFilePath(value: unknown): string {
	const input = requiredString(value, "Note file path is required");
	const path = normalize(input, false);
	if (!path.startsWith(`${NOTES_ROOT}/`))
		throw new Error("Absolute note paths must use /notes/<path>");
	return path;
}

export function normalizePrefix(value: unknown): string {
	if (value === undefined || value === null || value === "")
		return `${NOTES_ROOT}/`;
	if (typeof value !== "string")
		throw new Error("Note prefix must be a string");
	const path = normalize(value, true);
	if (path === NOTES_ROOT) return `${path}/`;
	if (!path.startsWith(`${NOTES_ROOT}/`))
		throw new Error("Absolute note prefixes must use /notes[/path]");
	return path;
}

function normalize(input: string, prefix: boolean): string {
	const path = input.startsWith("/") ? input : `${NOTES_ROOT}/${input}`;
	const components = path.slice(1).split("/");
	if (components.some((part) => !part || part === "." || part === ".."))
		throw new Error(
			`Note ${prefix ? "prefixes" : "paths"} cannot contain empty, . or .. components`,
		);
	return `/${components.join("/")}`;
}
