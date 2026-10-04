import { type Context, copyJson } from "@earendil-works/chord";
import {
	defineExtension,
	defineTool,
	type Harness,
	section,
	type TaskId,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import {
	adaptiveWaitMs,
	CODE_MODE_EXEC_CONSTRAINED_SAMPLING as NOTEBOOK_EXEC_CONSTRAINED_SAMPLING,
	parseExecSource,
} from "../../execution/src/exec-source.ts";
import { createCellCoordinator } from "../../execution/src/index.ts";
import {
	createShellRuntime,
	type ShellRuntimeOptions,
} from "../../execution/src/shell.ts";
import { readToolContract } from "../../execution/src/tool-contract.ts";
import { directToolYieldTime } from "../../execution/src/tool-source.ts";
import { createNotebookEngine, type NotebookEngineOptions } from "./engine.ts";
import {
	NOTEBOOK_HELP,
	NOTEBOOK_PARAMETERS,
	parseNotebookRequest,
} from "./notebook-control.ts";
import { notebookCellTaskId, observeNotebookCell } from "./tool-observation.ts";

export type {
	CustomCommandBackend,
	CustomCommandRequest,
	NodeCommandBackendOptions,
} from "../../execution/src/command-backend.ts";
export { createNodeCommandBackend } from "../../execution/src/command-backend.ts";
export type {
	CustomCommandDefinition,
	CustomCommandParseOptions,
} from "../../execution/src/custom-command-config.ts";
export { parseCustomCommand } from "../../execution/src/custom-command-config.ts";
export type {
	CustomCommandDiscovery,
	CustomCommandDiscoveryError,
	CustomCommandOptions,
	CustomCommandRoot,
	LiveCustomCommandOptions,
} from "../../execution/src/custom-commands.ts";
export {
	createCustomCommands,
	discoverCustomCommands,
	loadCustomCommandTools,
} from "../../execution/src/custom-commands.ts";
export {
	CODE_MODE_EXEC_CONSTRAINED_SAMPLING as NOTEBOOK_EXEC_CONSTRAINED_SAMPLING,
	CODE_MODE_EXEC_GRAMMAR as NOTEBOOK_EXEC_GRAMMAR,
} from "../../execution/src/exec-source.ts";
export type {
	NodeShellBackendOptions,
	ShellOutputStream,
	ShellProcess,
	ShellProcessBackend,
	ShellProcessEvents,
	ShellRuntimeOptions,
	ShellSpawnRequest,
} from "../../execution/src/shell.ts";
export { createNodeShellBackend } from "../../execution/src/shell.ts";
export type {
	ExecutionToolHints,
	ExecutionToolRegistration,
} from "../../execution/src/tool-contract.ts";
export type { NotebookEngineOptions } from "./engine.ts";

export interface NotebookModeOptions extends NotebookEngineOptions {
	shell: ShellRuntimeOptions;
	cancelTask: (
		id: TaskId,
		context: Context,
	) => ReturnType<Harness["abortTask"]>;
}

/** One application-owned Notebook component, with lazily started private conversation kernels. */
export function createNotebookMode(options: NotebookModeOptions) {
	const engine = createNotebookEngine(options);
	const shell = createShellRuntime(options.shell);
	const coordinator = createCellCoordinator({
		name: "notebook",
		engine,
		surfaceTools: ["exec", "wait", "notebook"],
		cancelTask: options.cancelTask,
	});
	const waitAttempts = new Map<TaskId, number>();
	const exec = defineTool({
		name: "exec",
		description: "Run TypeScript in a persistent Deno notebook",
		parameters: Type.Object(
			{ code: Type.String() },
			{ additionalProperties: false },
		),
		replay: "unsafe",
		constrainedSampling: NOTEBOOK_EXEC_CONSTRAINED_SAMPLING,
		outputLimits: {
			maxBytes: 4 * 100000 + 8192,
			maxLines: Number.MAX_SAFE_INTEGER,
		},
		prepareArguments(value) {
			if (typeof value === "string") return { code: value };
			if (
				!value ||
				typeof value !== "object" ||
				!("code" in value) ||
				typeof value.code !== "string"
			)
				throw new Error("exec requires TypeScript source");
			return { code: value.code };
		},
		async execute(args, api, context) {
			const parsed = parseExecSource(args.code);
			const contracts = (await api.agent(context)).tools
				.map(readToolContract)
				.filter((contract) => !contract.nativeOnly);
			const yieldTimeMs =
				directToolYieldTime(parsed.code, contracts) ??
				parsed.yieldTimeMs ??
				30000;
			const id = await coordinator.start(
				{
					code: parsed.code,
					max_output_tokens: parsed.maxOutputTokens ?? 10000,
				},
				api,
				context,
			);
			return observeNotebookCell(
				await coordinator.wait(id, api, context, yieldTimeMs),
				parsed.maxOutputTokens ?? 10000,
				api,
				context,
			);
		},
	});
	const wait = defineTool({
		name: "wait",
		description: "Resume or terminate a yielded exec cell",
		replay: "unsafe",
		outputLimits: {
			maxBytes: 4 * 100000 + 8192,
			maxLines: Number.MAX_SAFE_INTEGER,
		},
		parameters: Type.Object(
			{
				cell_id: Type.String(),
				yield_time_ms: Type.Optional(Type.Integer({ minimum: 0 })),
				max_tokens: Type.Optional(
					Type.Integer({ minimum: 1, maximum: 100000 }),
				),
				terminate: Type.Optional(Type.Boolean()),
			},
			{ additionalProperties: false },
		),
		async execute(args, api, context) {
			const id = notebookCellTaskId(args.cell_id);
			try {
				const observation = args.terminate
					? await coordinator.cancel(id, api, context)
					: await coordinator.wait(
							id,
							api,
							context,
							adaptiveWaitMs(
								args.yield_time_ms ?? 10000,
								waitAttempts.get(id) ?? 0,
							),
						);
				if (observation.status === "running")
					waitAttempts.set(id, (waitAttempts.get(id) ?? 0) + 1);
				else waitAttempts.delete(id);
				return await observeNotebookCell(
					observation,
					args.max_tokens ?? 10000,
					api,
					context,
				);
			} catch (error) {
				waitAttempts.delete(id);
				throw error;
			}
		},
	});
	const notebook = defineTool({
		name: "notebook",
		description: "Manage persistent notebook state",
		parameters: NOTEBOOK_PARAMETERS,
		replay: "unsafe",
		async execute(args, api, context) {
			if (args.input === "help")
				return {
					content: [{ type: "text" as const, text: NOTEBOOK_HELP }],
					details: { action: "help" },
				};
			let value: unknown;
			try {
				value = JSON.parse(args.input);
			} catch (error) {
				throw new Error("notebook input must be help or a JSON action object", {
					cause: error,
				});
			}
			const request = parseNotebookRequest(value);
			const result = await engine.control(request, api, context);
			return {
				content: [{ type: "text" as const, text: result.message }],
				details: copyJson(result.details, { omitUndefinedProperties: true }),
			};
		},
	});
	const extension = defineExtension({
		...coordinator.extension,
		tools: [exec, wait, notebook, ...shell.tools],
		sections: [
			section("notebook", (input) => {
				const base =
					"exec: TypeScript, top-level await and globals persist. Bare values are discarded. Use text(value), image(value), generatedImage(value), notify(value), store(key,value), load(key), exit() and yield_control(). ALL_TOOLS lists selected tool contracts. Inspect foo.description, foo.usage, bar.description and bar.usage before constructing reusable globals. Ask before new npm imports, then use exact-version npm: specifiers. Inside exec tools.notebook supports status without query, list and diagnostics. Run other notebook actions after exec returns.";
				const promoted = input.agent.tools
					.filter((tool) => !["exec", "wait", "notebook"].includes(tool.name))
					.map(readToolContract)
					.filter((contract) => !contract.nativeOnly && !contract.deferLoading)
					.map((contract) => contract.usage);
				return [base, ...promoted].join("\n");
			}),
		],
	});
	let closing: Promise<void> | undefined;
	return {
		extension,
		/** Bind the same Harness that owns this extension to retain native-only provider tools. */
		bind: coordinator.bind,
		close(): Promise<void> {
			waitAttempts.clear();
			return (closing ??= Promise.all([
				coordinator.close(),
				shell.close(),
			]).then(() => undefined));
		},
	};
}
