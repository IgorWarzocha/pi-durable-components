// Adapted from pi-codex-conversion custom-tools.ts, MIT. See ../NOTICE.
import { posix, win32 } from "node:path";
import { parse } from "smol-toml";

export interface CustomCommandDefinition {
	name: string;
	usage: string;
	description?: string;
	output?: string;
	deferLoading: boolean;
	command: string;
	args: string[];
	input: "arg" | "stdin";
	yieldTimeMs?: number;
	sourcePath: string;
	disabledReason?: string;
}

export interface CustomCommandParseOptions {
	platform: string;
	/** JavaScript launcher in the command backend's namespace. */
	javascriptRuntime: string;
}

export const CUSTOM_TOOL_NAME_PATTERN = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

export function customCommandName(path: string, platform: string): string {
	const paths = platform === "win32" ? win32 : posix;
	return paths.basename(path, paths.extname(path));
}

export function parseCustomCommand(
	path: string,
	text: string,
	options: CustomCommandParseOptions,
): CustomCommandDefinition {
	const paths = options.platform === "win32" ? win32 : posix;
	const name = customCommandName(path, options.platform);
	if (!CUSTOM_TOOL_NAME_PATTERN.test(name))
		throw new Error(
			`${path}: filename must be a JavaScript-compatible tool name`,
		);
	const value = parse(text);
	const known = new Set([
		"usage",
		"description",
		"output",
		"defer_loading",
		"command",
		"args",
		"input",
		"yield_time_ms",
	]);
	const unknown = Object.keys(value).filter((key) => !known.has(key));
	if (unknown.length)
		throw new Error(
			`${path}: unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`,
		);
	const command = requiredString(value["command"], "command", path);
	const args = value["args"] ?? [];
	if (!Array.isArray(args))
		throw new Error(`${path}: args must be an array of strings`);
	const stringArgs = args.map((item) => {
		if (typeof item !== "string")
			throw new Error(`${path}: args must be an array of strings`);
		return item;
	});
	const input = value["input"] ?? "arg";
	if (input !== "arg" && input !== "stdin")
		throw new Error(`${path}: input must be "arg" or "stdin"`);
	const deferred = value["defer_loading"] ?? true;
	if (typeof deferred !== "boolean")
		throw new Error(`${path}: defer_loading must be a boolean`);
	const yieldTimeMs = value["yield_time_ms"];
	if (
		yieldTimeMs !== undefined &&
		(!Number.isSafeInteger(yieldTimeMs) || Number(yieldTimeMs) < 0)
	) {
		throw new Error(
			`${path}: yield_time_ms must be a non-negative safe integer`,
		);
	}
	const resolvedCommand =
		!paths.isAbsolute(command) &&
		(command.includes("/") || command.includes("\\"))
			? paths.resolve(paths.dirname(path), command)
			: command;
	const script =
		paths.isAbsolute(resolvedCommand) &&
		/\.(?:cjs|mjs|js)$/i.test(resolvedCommand);
	const description = optionalString(value["description"], "description", path);
	const output = optionalString(value["output"], "output", path);
	return {
		name,
		usage: requiredString(value["usage"], "usage", path),
		...(description === undefined ? {} : { description }),
		...(output === undefined ? {} : { output }),
		deferLoading: deferred,
		command: script ? options.javascriptRuntime : resolvedCommand,
		args: script ? [resolvedCommand, ...stringArgs] : stringArgs,
		input,
		sourcePath: path,
		...(yieldTimeMs === undefined ? {} : { yieldTimeMs: Number(yieldTimeMs) }),
	};
}

function requiredString(value: unknown, field: string, path: string): string {
	if (typeof value !== "string" || !value.trim())
		throw new Error(`${path}: ${field} must be a non-empty string`);
	return value.trim();
}

function optionalString(
	value: unknown,
	field: string,
	path: string,
): string | undefined {
	return value === undefined ? undefined : requiredString(value, field, path);
}
