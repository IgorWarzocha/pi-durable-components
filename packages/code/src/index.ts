import {
	defineTool,
	section,
	type TaskId,
	type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import {
	CODE_MODE_EXEC_CONSTRAINED_SAMPLING,
	parseExecSource,
} from "../../execution/src/exec-source.ts";
import {
	adaptiveWaitMs,
	type CellCoordinatorOptions,
	createCellCoordinator,
	directToolYieldTime,
	readToolContract,
} from "../../execution/src/index.ts";
import {
	createShellRuntime,
	type ShellRuntimeOptions,
} from "../../execution/src/shell.ts";
import type { HostOptions } from "./binary.ts";
import { observeCodeCell } from "./cell-output.ts";
import { CodeEngine } from "./engine.ts";

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
	CODE_MODE_EXEC_CONSTRAINED_SAMPLING,
	CODE_MODE_EXEC_GRAMMAR,
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

export interface CodeModeOptions extends HostOptions {
	shell: ShellRuntimeOptions;
	cancelTask: CellCoordinatorOptions["cancelTask"];
}

const execSchema = Type.Object({ code: Type.String() });
const waitSchema = Type.Object({
	cell_id: Type.String(),
	yield_time_ms: Type.Optional(Type.Integer({ minimum: 0, default: 10_000 })),
	max_tokens: Type.Optional(
		Type.Integer({ minimum: 1, maximum: 100_000, default: 10_000 }),
	),
	terminate: Type.Optional(Type.Boolean()),
});

/** Public Code product. Ordinary tools are discovered from the selected Durable registry. */
export function createCodeMode(options: CodeModeOptions) {
	const shell = createShellRuntime(options.shell);
	const engine = new CodeEngine(options);
	const acknowledge = engine.acknowledge.bind(engine);
	const coordinator = createCellCoordinator({
		name: "code",
		engine,
		surfaceTools: ["exec", "wait"],
		cancelTask: options.cancelTask,
	});
	const waitAttempts = new Map<number, number>();
	const exec = defineTool({
		name: "exec",
		description: "Run JavaScript; bare values are discarded",
		parameters: execSchema,
		constrainedSampling: CODE_MODE_EXEC_CONSTRAINED_SAMPLING,
		replay: "unsafe",
		outputLimits: {
			maxBytes: 2 * 1024 * 1024,
			maxLines: Number.MAX_SAFE_INTEGER,
		},
		prepareArguments: (args) =>
			typeof args === "string" ? { code: args } : execArguments(args),
		async execute(args, api, context) {
			const parsed = parseExecSource(args.code);
			const contracts = (await api.agent(context)).tools
				.filter((tool) => tool.name !== "exec" && tool.name !== "wait")
				.map(readToolContract)
				.filter((contract) => !contract.nativeOnly);
			const yieldMs =
				directToolYieldTime(parsed.code, contracts) ??
				parsed.yieldTimeMs ??
				30_000;
			const id = await coordinator.start({ code: args.code }, api, context);
			return observeCodeCell(
				await coordinator.wait(id, api, context, yieldMs),
				parsed.maxOutputTokens ?? 10_000,
				acknowledge,
			);
		},
	});
	const wait = defineTool({
		name: "wait",
		description: "Resume or terminate a yielded exec cell",
		parameters: waitSchema,
		replay: "unsafe",
		outputLimits: {
			maxBytes: 2 * 1024 * 1024,
			maxLines: Number.MAX_SAFE_INTEGER,
		},
		async execute(args, api, context) {
			const value = Number(args.cell_id);
			if (!Number.isSafeInteger(value) || value <= 0)
				throw new Error("cell_id must be a valid yielded cell ID");
			const id = value as TaskId<ToolExecutionResult>;
			try {
				const observation = args.terminate
					? await coordinator.cancel(id, api, context)
					: await coordinator.wait(
							id,
							api,
							context,
							adaptiveWaitMs(
								args.yield_time_ms ?? 10_000,
								waitAttempts.get(id) ?? 0,
							),
						);
				if (observation.status === "running")
					waitAttempts.set(id, (waitAttempts.get(id) ?? 0) + 1);
				else waitAttempts.delete(id);
				return observeCodeCell(
					observation,
					args.max_tokens ?? 10_000,
					acknowledge,
				);
			} catch (error) {
				waitAttempts.delete(id);
				throw error;
			}
		},
	});
	return {
		/** Bind the same Harness that owns this extension to retain native-only provider tools. */
		bind: coordinator.bind,
		extension: {
			...coordinator.extension,
			tools: [exec, wait, ...shell.tools],
			sections: [
				section("code", (input) => {
					const usage = input.agent.tools
						.filter((tool) => tool.name !== "exec" && tool.name !== "wait")
						.map(readToolContract)
						.filter(
							(contract) => !contract.nativeOnly && !contract.deferLoading,
						)
						.map((contract) => contract.usage)
						.join("\n");
					return [
						'exec accepts JavaScript source with optional // @exec: {"yield_time_ms":30000,"max_output_tokens":10000}. Await work and emit with text(value), image(value), generatedImage(value), notify(value). tools contains ordinary registered tools. ALL_TOOLS lists callable contracts. store(key,value)/load(key) retain serializable values between cells. Cells have no filesystem, network or Node globals. Shell tools follow the conversation environment. Use wait for exec cells and tools.write_stdin for shell sessions.',
						usage,
					]
						.filter(Boolean)
						.join("\n");
				}),
			],
		},
		async close(): Promise<void> {
			waitAttempts.clear();
			await Promise.all([coordinator.close(), shell.close()]);
		},
	};
}

function execArguments(value: unknown): { code: string } {
	if (
		!value ||
		typeof value !== "object" ||
		!("code" in value) ||
		typeof value.code !== "string"
	)
		throw new Error("exec requires JavaScript source");
	return { code: value.code };
}
