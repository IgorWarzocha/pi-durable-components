import { type Context } from "@earendil-works/chord";
import {
	defineTool,
	section,
	type TaskId,
	type ToolControl,
	type ToolExecutionApi,
	type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { type CellCoordinatorOptions } from "../../execution/src/cell-contract.ts";
import { cellTools } from "../../execution/src/cell-tools.ts";
import { createCellCoordinator } from "../../execution/src/cells.ts";
import { combineControls } from "../../execution/src/controls.ts";
import {
	CODE_MODE_EXEC_CONSTRAINED_SAMPLING,
	parseExecSource,
} from "../../execution/src/exec-source.ts";
import { readToolContract } from "../../execution/src/tool-contract.ts";
import {
	interpreterBudget,
	WORKER_CODE_ISOLATE_BUDGET,
} from "./interpreter.ts";
import { type WorkerCodeLimits, workerLimits } from "./limits.ts";
import {
	moduleCode,
	moduleSnapshot,
	type WorkerModuleRequest,
} from "./modules.ts";
import { guestContent, observeWorkerCell } from "./output.ts";
import { WorkerRuntime } from "./runtime.ts";
import { guestToolResult } from "./tool-result.ts";

export type { WorkerCodeLimits } from "./limits.ts";
export { DEFAULT_WORKER_CODE_LIMITS } from "./limits.ts";
export type { WorkerModuleRequest } from "./modules.ts";
export { WORKER_CODE_ISOLATE_BUDGET };

export interface WorkerCodeOptions {
	/** Static compiled QuickJS 0.32.0 release-sync WASM, injected by the host bundler. */
	readonly wasmModule: WebAssembly.Module;
	readonly cancelTask: CellCoordinatorOptions["cancelTask"];
	readonly limits?: Partial<WorkerCodeLimits>;
	readonly modules?:
		| Readonly<Record<string, string>>
		| (() => Readonly<Record<string, string>>);
}

/** Worker-native execution. Never imports shell, native Code, or host filesystem drivers. */
export function createWorkerCode(options: WorkerCodeOptions) {
	const limits = workerLimits(options.limits);
	const source = options.modules ?? {};
	let modules: () => ReadonlyMap<string, string>;
	if (typeof source === "function")
		modules = () => moduleSnapshot(source(), limits);
	else {
		const snapshot = moduleSnapshot(source, limits);
		modules = () => snapshot;
	}
	const engine = new WorkerRuntime(options.wasmModule, limits, modules);
	const coordinator = createCellCoordinator({
		name: "worker-code",
		engine,
		surfaceTools: ["exec", "wait"],
		cancelTask: options.cancelTask,
	});
	const delivered = new Map<number, number>();
	const exec = defineTool({
		name: "exec",
		description: "Run bounded JavaScript; bare values are discarded",
		parameters: Type.Object({ code: Type.String() }),
		constrainedSampling: CODE_MODE_EXEC_CONSTRAINED_SAMPLING,
		replay: "unsafe",
		outputLimits: {
			maxBytes: limits.maxOutputBytes,
			maxLines: Number.MAX_SAFE_INTEGER,
		},
		prepareArguments: (args) => {
			if (typeof args === "string") return { code: args };
			if (
				args === null ||
				typeof args !== "object" ||
				!("code" in args) ||
				typeof args.code !== "string"
			)
				throw new Error("exec requires JavaScript source");
			return { code: args.code };
		},
		async execute(args, api, context) {
			const parsed = parseExecSource(args.code);
			const id = await coordinator.start({ code: parsed.code }, api, context);
			return observeWorkerCell(
				await coordinator.wait(id, api, context, parsed.yieldTimeMs ?? 10000),
				parsed.maxOutputTokens ?? 10000,
				delivered,
			);
		},
	});
	const wait = defineTool({
		name: "wait",
		description: "Observe or terminate a yielded exec cell",
		parameters: Type.Object({
			cell_id: Type.String(),
			yield_time_ms: Type.Optional(
				Type.Integer({ minimum: 0, maximum: 30000, default: 10000 }),
			),
			max_tokens: Type.Optional(
				Type.Integer({ minimum: 1, maximum: 100000, default: 10000 }),
			),
			terminate: Type.Optional(Type.Boolean()),
		}),
		replay: "unsafe",
		outputLimits: {
			maxBytes: limits.maxOutputBytes,
			maxLines: Number.MAX_SAFE_INTEGER,
		},
		async execute(args, api, context) {
			const value = Number(args.cell_id);
			if (!Number.isSafeInteger(value) || value <= 0)
				throw new Error("cell_id must be a valid yielded cell ID");
			const id = value as TaskId<ToolExecutionResult>;
			const observed = args.terminate
				? await coordinator.cancel(id, api, context)
				: await coordinator.wait(id, api, context, args.yield_time_ms ?? 10000);
			return observeWorkerCell(observed, args.max_tokens ?? 10000, delivered);
		},
	});
	return {
		extension: {
			...coordinator.extension,
			tools: [exec, wait],
			sections: [
				section("worker-code", (input) =>
					[
						"exec runs fresh bounded JavaScript. Await tools[name](args) and emit with text(value) or image({data,mimeType}). ALL_TOOLS lists callable contracts with original names. await yield_control() wakes the observer. Use wait for running cells. Guest globals and imports do not persist. No shell, ambient network or native globals.",
						...input.agent.tools
							.filter((tool) => tool.name !== "exec" && tool.name !== "wait")
							.map(readToolContract)
							.filter(
								(contract) => !contract.nativeOnly && !contract.deferLoading,
							)
							.map((contract) => contract.usage),
					].join("\n"),
				),
			],
		},
		bind: coordinator.bind,
		budget: interpreterBudget,
		async evaluateModule(
			request: WorkerModuleRequest,
			invocation: { readonly signal?: AbortSignal } = {},
		) {
			const sources = moduleSnapshot(request.modules, limits);
			return (
				await engine.evaluate(
					moduleCode(request, limits, Object.hasOwn(request, "args")),
					sources,
					invocation.signal,
				)
			).value;
		},
		/** Reuse the cell dispatcher under the CURRENT ordinary tool task, not another cell. */
		async executeToolModule(
			request: WorkerModuleRequest,
			api: ToolExecutionApi,
			context: Context,
			grants: { readonly allowedTools?: readonly string[] } = {},
		): Promise<ToolExecutionResult> {
			const sources = moduleSnapshot(request.modules, limits);
			const allowed = new Set(grants.allowedTools ?? []);
			const registrations = (await api.agent(context)).tools.filter(
				(tool) =>
					allowed.has(tool.name) &&
					tool.name !== "exec" &&
					tool.name !== "wait" &&
					!readToolContract(tool).nativeOnly,
			);
			const controls: (ToolControl | undefined)[] = [];
			const signal = context.abortSignal ?? new AbortController().signal;
			const tools = cellTools(
				{
					taskId: api.taskId,
					signal,
					waitForTask: api.waitForTask.bind(api),
					report: (error) =>
						api.diagnostic({
							severity: "error",
							code: "nested_cancel_error",
							message: error instanceof Error ? error.message : String(error),
						}),
				},
				api,
				registrations,
				coordinator.nestedTask,
				controls,
				options.cancelTask,
				context,
			);
			const output: NonNullable<ToolExecutionResult["content"]> = [];
			const evaluated = await engine.evaluate(
				moduleCode(request, limits, true),
				sources,
				signal,
				{
					tools,
					emit: async (kind, value) => {
						output.push(guestContent(kind, value));
					},
				},
			);
			const result = guestToolResult(evaluated.value);
			const control = combineControls([...controls, result.control]);
			return {
				...result,
				...(result.content === undefined && output.length
					? { content: output }
					: {}),
				...(control === undefined ? {} : { control }),
			};
		},
		async close() {
			delivered.clear();
			await coordinator.close();
		},
	};
}
