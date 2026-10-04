import type { Context } from "@earendil-works/chord";
import {
	defineExtension,
	defineTool,
	GenerationTask,
	hook,
	type Registry,
} from "@earendil-works/pi-durable";
import { type FileSystem, getOrThrow } from "@earendil-works/pi-durable/env";
import { Type } from "typebox";
import type { CustomCommandBackend } from "./command-backend.ts";
import {
	CUSTOM_TOOL_NAME_PATTERN,
	type CustomCommandDefinition,
	customCommandName,
	parseCustomCommand,
} from "./custom-command-config.ts";
import type { ExecutionToolRegistration } from "./tool-contract.ts";

export interface CustomCommandRoot {
	path: string;
	/** The host owns trust. An untrusted root is never read. Later trusted roots override earlier roots. */
	trusted: boolean;
}

export interface CustomCommandOptions {
	files: FileSystem;
	backend: CustomCommandBackend;
	roots: readonly CustomCommandRoot[];
	name?: string;
}

export interface CustomCommandDiscoveryError {
	path: string;
	message: string;
}
export interface CustomCommandDiscovery {
	tools: CustomCommandDefinition[];
	errors: CustomCommandDiscoveryError[];
}

export interface LiveCustomCommandOptions extends CustomCommandOptions {
	registry: Registry;
	onDiscoveryError?(error: CustomCommandDiscoveryError): void;
}

/** Explicit trusted-root discovery. No ambient Pi directory, parent search, or bundled examples. */
export async function discoverCustomCommands(
	options: CustomCommandOptions,
	context: Context,
): Promise<CustomCommandDiscovery> {
	if (options.files.id !== options.backend.environmentId)
		throw new Error(
			"Custom command filesystem and process backend must share an environment namespace",
		);
	const byName = new Map<string, CustomCommandDefinition>();
	const errors: CustomCommandDiscoveryError[] = [];
	for (const root of options.roots) {
		if (!root.trusted) continue;
		context.abortSignal?.throwIfAborted();
		const directory = await options.files.absolutePath(root.path, context);
		if (!directory.ok) {
			errors.push({ path: root.path, message: directory.error.message });
			continue;
		}
		const listed = await options.files.listDir(directory.value, context);
		if (!listed.ok) {
			if (listed.error.code !== "not_found")
				errors.push({
					path: directory.value,
					message: `${directory.value}: ${listed.error.message}`,
				});
			continue;
		}
		const paths = listed.value
			.filter((entry) => entry.kind === "file" && entry.name.endsWith(".toml"))
			.sort((left, right) => left.name.localeCompare(right.name))
			.map((entry) => entry.path);
		for (const path of paths) {
			const name = customCommandName(path, options.backend.platform);
			byName.delete(name); // Invalid overrides still claim their name.
			try {
				const contents = getOrThrow(
					await options.files.readTextFile(path, context),
				);
				byName.set(name, parseCustomCommand(path, contents, options.backend));
			} catch (error) {
				context.abortSignal?.throwIfAborted();
				const detail = error instanceof Error ? error.message : String(error);
				const message = detail.startsWith(`${path}:`)
					? detail
					: `${path}: ${detail}`;
				if (!CUSTOM_TOOL_NAME_PATTERN.test(name)) {
					errors.push({ path, message });
					continue;
				}
				byName.set(name, {
					name,
					usage: "Disabled: fix this tool's TOML definition before calling it",
					description: message,
					deferLoading: true,
					command: "",
					args: [],
					input: "arg",
					sourcePath: path,
					disabledReason: message,
				});
			}
		}
	}
	return {
		tools: [...byName.values()].sort((left, right) =>
			left.name.localeCompare(right.name),
		),
		errors,
	};
}

const parameters = Type.Object(
	{ input: Type.String() },
	{ additionalProperties: false },
);

/** Load TOML commands as ordinary registrations. Re-run this factory and install its returned extension to refresh inventory. */
export async function loadCustomCommandTools(
	options: CustomCommandOptions,
	context: Context,
) {
	const roots: CustomCommandRoot[] = [];
	for (const root of options.roots) {
		if (!root.trusted) continue;
		roots.push({
			path: getOrThrow(await options.files.absolutePath(root.path, context)),
			trusted: true,
		});
	}
	const scoped = { ...options, roots };
	const discovered = await discoverCustomCommands(scoped, context);
	const tools = discovered.tools.map((definition) =>
		createCustomCommandTool(definition, scoped),
	);
	return {
		extension: defineExtension({
			name: options.name ?? "custom-commands",
			tools,
		}),
		tools,
		errors: discovered.errors,
	};
}

/** Live config inventory through supported ordinary registry publications, not a Code dispatch adapter. */
export async function createCustomCommands(
	options: LiveCustomCommandOptions,
	context: Context,
) {
	const initial = await loadCustomCommandTools(options, context);
	let closed = false;
	let errors = initial.errors;
	let refreshing:
		| Promise<ReturnType<typeof options.registry.snapshot>>
		| undefined;
	const reported = new Map<string, string>();
	const report = (errors: CustomCommandDiscoveryError[]) => {
		const next = new Map(errors.map((error) => [error.path, error.message]));
		for (const error of errors)
			if (reported.get(error.path) !== error.message)
				options.onDiscoveryError?.(error);
		reported.clear();
		for (const [path, message] of next) reported.set(path, message);
	};
	const refreshHook = hook(GenerationTask, {
		beforeRequest: async (_request, _api, refreshContext) => {
			await refresh(refreshContext);
		},
	});
	const extension = { ...initial.extension, hooks: [refreshHook] };
	report(initial.errors);
	options.registry.install(extension);
	async function refresh(refreshContext: Context) {
		if (closed) throw new Error("Custom command loader is closed");
		if (refreshing) return refreshing;
		refreshing = (async () => {
			const current = await loadCustomCommandTools(options, refreshContext);
			if (closed) throw new Error("Custom command loader is closed");
			errors = current.errors;
			report(current.errors);
			options.registry.install({ ...extension, tools: current.tools });
			return options.registry.snapshot();
		})();
		try {
			return await refreshing;
		} finally {
			refreshing = undefined;
		}
	}
	return {
		extension,
		refresh,
		get errors(): readonly CustomCommandDiscoveryError[] {
			return errors;
		},
		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			await refreshing?.catch(() => undefined);
			if (
				options.registry
					.snapshot()
					.extension(extension.name)
					?.hooks?.includes(refreshHook)
			)
				options.registry.uninstall(extension);
		},
	};
}

function createCustomCommandTool(
	definition: CustomCommandDefinition,
	options: CustomCommandOptions,
): ExecutionToolRegistration<typeof parameters> {
	const tool = defineTool({
		name: definition.name,
		replay: "unsafe",
		parameters,
		description: definition.description ?? "Run configured command",
		outputLimits: { maxBytes: 50 * 1024, maxLines: Number.MAX_SAFE_INTEGER },
		prepareArguments: (value) => {
			if (typeof value === "string") return { input: value };
			if (
				value &&
				typeof value === "object" &&
				"input" in value &&
				typeof value.input === "string"
			)
				return { input: value.input };
			throw new Error(`${definition.name} expects a string input`);
		},
		async execute(args, api, context) {
			if (!api.env || api.env.id !== options.backend.environmentId)
				throw new Error(
					`Custom command backend is bound to ${options.backend.environmentId}, not the conversation's environment`,
				);
			const current = (
				await discoverCustomCommands({ ...options, files: api.env }, context)
			).tools.find((tool) => tool.name === definition.name);
			if (!current)
				throw new Error(`${definition.name} is no longer configured`);
			if (current.disabledReason)
				throw new Error(
					`${current.name} is disabled: ${current.disabledReason}`,
				);
			context.abortSignal?.throwIfAborted();
			try {
				const output = await options.backend.run(
					{
						command: current.command,
						args:
							current.input === "arg"
								? [...current.args, args.input]
								: current.args,
						cwd: api.env.cwd,
						...(current.input === "stdin" ? { stdin: args.input } : {}),
					},
					context.abortSignal,
				);
				return { content: [{ type: "text", text: output }], details: output };
			} catch (error) {
				throw new Error(
					`${current.name}: ${error instanceof Error ? error.message : String(error)}`,
					{ cause: error },
				);
			}
		},
	});
	return {
		...tool,
		executionHints: {
			usage: definition.usage,
			deferLoading: definition.deferLoading,
			inputSchema: { type: "string" },
			...(definition.output === undefined ? {} : { output: definition.output }),
			...(definition.yieldTimeMs === undefined
				? {}
				: { yieldTimeMs: definition.yieldTimeMs }),
		},
	};
}
