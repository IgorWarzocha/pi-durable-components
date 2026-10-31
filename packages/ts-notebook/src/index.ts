import { type Context, copyJson } from "@earendil-works/chord";
import {
	defineExtension,
	defineTool,
	type Harness,
	section,
	type TaskId,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { Check } from "typebox/value";
import {
	adaptiveWaitMs,
	CODE_MODE_EXEC_CONSTRAINED_SAMPLING as NOTEBOOK_EXEC_CONSTRAINED_SAMPLING,
	parseExecSource,
} from "../../execution/src/exec-source.ts";
import { createCellCoordinator } from "../../execution/src/index.ts";
import { InvocationDoc } from "../../execution/src/invocation-state.ts";
import {
	createShellRuntime,
	type ShellRuntimeOptions,
} from "../../execution/src/shell.ts";
import { readToolContract } from "../../execution/src/tool-contract.ts";
import { directToolYieldTime } from "../../execution/src/tool-source.ts";
import { canExecuteNotebookControlInsideExec } from "../../notebook/src/control-contract.ts";
import {
	notebookCellTaskId,
	observeNotebookCell,
} from "../../notebook/src/tool-observation.ts";
import {
	createTsNotebookEngine,
	type NotebookEngineOptions,
} from "./engine.ts";
import {
	NOTEBOOK_ACTION_PARAMETERS,
	NOTEBOOK_HELP,
	NOTEBOOK_PARAMETERS,
	parseNotebookRequest,
} from "./notebook-control.ts";

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
export function createTsNotebookMode(options: NotebookModeOptions) {
	const engine = createTsNotebookEngine(options);
	const shell = createShellRuntime(options.shell);
	const coordinator = createCellCoordinator({
		name: "ts-notebook",
		engine,
		surfaceTools: ["exec", "wait", "notebook"],
		callableSurfaceTools: ["notebook"],
		cancelTask: options.cancelTask,
		isolatedConcurrency: 4,
		normalQueueLimit: 4,
		activeCellLimit: 4,
	});
	const waitAttempts = new Map<TaskId, number>();
	const exec = defineTool({
		name: "exec",
		description:
			"Run TypeScript in a persistent strictly checked TypeScript notebook; isolated:true saves a separate candidate",
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
			const parsed = parseExecSource(args.code, { allowIsolated: true });
			const contracts = (await api.agent(context)).callable
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
					isolated: parsed.isolated,
				},
				api,
				context,
			);
			return observeNotebookCell(
				await coordinator.wait(
					id,
					api,
					context,
					yieldTimeMs,
					parsed.maxOutputTokens ?? 10000,
				),
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
					? await coordinator.cancel(id, api, context, args.max_tokens ?? 10000)
					: await coordinator.wait(
							id,
							api,
							context,
							adaptiveWaitMs(
								args.yield_time_ms ?? 10000,
								waitAttempts.get(id) ?? 0,
							),
							args.max_tokens ?? 10000,
							args.yield_time_ms ?? 10000,
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
		structuredOutputSchema: Type.Object({
			message: Type.String(),
			details: Type.Record(Type.String(), Type.Unknown()),
		}),
		replay: "unsafe",
		prepareArguments(value) {
			if (value && typeof value === "object" && "action" in value)
				return { input: JSON.stringify(parseNotebookRequest(value)) };
			if (value === undefined || value === null) return {};
			if (!Check(NOTEBOOK_PARAMETERS, value))
				throw new Error(
					"notebook requires input: help or a JSON action object",
				);
			return value;
		},
		async execute(args, api, context) {
			if (args.input === undefined || args.input === "help")
				return {
					output: [{ type: "text" as const, text: NOTEBOOK_HELP }],
					details: { action: "help" },
					structuredOutput: {
						message: NOTEBOOK_HELP,
						details: { action: "help" },
					},
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
			const owner = await api.snapshot(InvocationDoc, api.taskId, context);
			if (
				owner?.forwardingCellId !== undefined &&
				!canExecuteNotebookControlInsideExec(request)
			) {
				const result = {
					message: `Notebook ${request.action} was not run because it needs the active exec cell to finish. After exec returns, call notebook with ${JSON.stringify({ input: JSON.stringify(request) })}.`,
					details: { notRun: true, action: request.action, retry: request },
				};
				return {
					output: [{ type: "text" as const, text: result.message }],
					details: copyJson(result.details),
					structuredOutput: copyJson(result),
				};
			}
			const result = await engine.control(request, api, context);
			return {
				output: [{ type: "text" as const, text: result.message }],
				details: copyJson(result.details, { omitUndefinedProperties: true }),
				structuredOutput: copyJson(result, { omitUndefinedProperties: true }),
			};
		},
	});
	const extension = defineExtension({
		...coordinator.extension,
		tools: [
			exec,
			wait,
			{
				...notebook,
				executionHints: {
					discovery: "help" as const,
					inputSchema: copyJson(
						JSON.parse(
							JSON.stringify(
								Type.Union([NOTEBOOK_PARAMETERS, NOTEBOOK_ACTION_PARAMETERS]),
							),
						),
					),
				},
			},
			...shell.tools,
		],
		sections: [
			section("notebook", (input) => {
				const base =
					'exec: Strict TypeScript with top-level await and retained live bindings, closures and classes. Bare values are discarded; use text(value). ALL_TOOLS lists selected tool contracts. Run normal cells sequentially. A leading // @exec: {"isolated":true} forks the last durable checkpoint and saves a candidate without changing live state. Only portable bindings survive restart; tool and file effects are never rolled back. Use notebook help for state, pins, hooks, checkpoint recipes and recovery.';
				const promoted = input.agent.callable
					.filter((tool) => !["exec", "wait", "notebook"].includes(tool.name))
					.map(readToolContract)
					.filter((contract) => !contract.nativeOnly && !contract.deferLoading)
					.map((contract) => contract.prompt);
				return [
					base,
					"For tools listed without a call signature, call with no arguments to get usage without performing an operation. Structured calls use {}.",
					...promoted,
				].join("\n");
			}),
			section("ts_state", (input, context) => engine.inventory(input, context)),
		],
	});
	let closing: Promise<void> | undefined;
	return {
		extension,
		/** Bind the owning Harness before execution to retain native nested display receipts and native-only tools. */
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
