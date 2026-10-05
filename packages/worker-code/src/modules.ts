import type { JsonValue } from "@earendil-works/chord";
import { boundedJson, boundedString, type WorkerCodeLimits } from "./limits.ts";

export interface WorkerModuleRequest {
	readonly modules: Readonly<Record<string, string>>;
	readonly entry: string;
	readonly exportName: string;
	/** Present to call the export as a function. Omit to read a JSON data export. */
	readonly args?: JsonValue;
}

/** Absolute virtual names only. Relative imports cannot escape the snapshot root. */
export function resolveModule(base: string, name: string): string {
	if (
		!name.startsWith("/") &&
		!name.startsWith("./") &&
		!name.startsWith("../")
	)
		throw new Error(`Module ${name} is not in the workspace snapshot`);
	if (name.includes("\\") || name.includes("\0") || name.includes(":"))
		throw new Error("Invalid workspace module path");
	const parts: string[] = [];
	const path = name.startsWith("/")
		? name
		: `${base.slice(0, base.lastIndexOf("/") + 1)}${name}`;
	for (const part of path.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			if (parts.length === 0)
				throw new Error("Workspace module path escapes root");
			parts.pop();
		} else parts.push(part);
	}
	return `/${parts.join("/")}`;
}

export function moduleSnapshot(
	input: Readonly<Record<string, string>>,
	limits: Readonly<WorkerCodeLimits>,
): ReadonlyMap<string, string> {
	const entries = Object.entries(input);
	if (entries.length > limits.maxModules)
		throw new Error("Workspace module count limit exceeded");
	const sources = new Map<string, string>();
	let bytes = 0;
	for (const [name, source] of entries) {
		if (
			!name.startsWith("/") ||
			resolveModule("/", name) !== name ||
			typeof source !== "string"
		)
			throw new Error(
				`Workspace module ${name} must have a canonical absolute path and string source`,
			);
		boundedString(source, limits.maxSourceBytes, "Module source");
		bytes += new TextEncoder().encode(name + source).byteLength;
		if (bytes > limits.maxModuleBytes)
			throw new Error("Workspace snapshot byte limit exceeded");
		sources.set(name, source);
	}
	return sources;
}

export function moduleCode(
	request: WorkerModuleRequest,
	limits: Readonly<WorkerCodeLimits>,
	invoke: boolean,
): string {
	if (
		!request.entry.startsWith("/") ||
		resolveModule("/", request.entry) !== request.entry
	)
		throw new Error("Module entry must be a canonical absolute workspace path");
	const member = `(await import(${JSON.stringify(request.entry)}))[${boundedJson(request.exportName, 256, "Export name")}]`;
	return `return ${member}${invoke ? `(${boundedJson(request.args ?? null, limits.maxArgumentBytes, "Module arguments")})` : ""};`;
}
