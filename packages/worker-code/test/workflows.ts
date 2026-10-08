import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
	createRegistry,
	defineTool,
	Harness,
	MemoryStorage,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { createWorkerCode, type WorkerCodeLimits } from "../src/index.ts";

const context = BACKGROUND_CONTEXT;
const entry = "/harness/main.mjs";
const unusedCancel = async () => {
	throw new Error("Pure module tried to cancel a Durable task");
};

export async function runtimeWorkflow(wasmModule: WebAssembly.Module) {
	const component = createWorkerCode({ wasmModule, cancelTask: unusedCancel });
	const evaluate = (code: string, modules: Record<string, string> = {}) =>
		component.evaluateModule({
			entry,
			exportName: "execute",
			args: null,
			modules: {
				...modules,
				[entry]: `export async function execute() { ${code} }`,
			},
		});
	const errors: Record<string, string> = {};
	const fails = async (
		name: string,
		code: string,
		limits?: Partial<WorkerCodeLimits>,
	) => {
		let bounded: ReturnType<typeof createWorkerCode> | undefined;
		try {
			bounded = createWorkerCode({
				wasmModule,
				cancelTask: unusedCancel,
				...(limits ? { limits } : {}),
			});
			await bounded.evaluateModule({
				entry,
				exportName: "execute",
				args: null,
				modules: { [entry]: `export async function execute() { ${code} }` },
			});
			throw new Error(`${name} unexpectedly succeeded`);
		} catch (error) {
			errors[name] = error instanceof Error ? error.message : String(error);
		} finally {
			await bounded?.close();
		}
	};
	try {
		const isolated = await evaluate(
			"return [typeof fetch,typeof process,typeof Deno,typeof env,typeof WebAssembly,typeof __dispatch,typeof text,typeof yield_control,typeof setTimeout,typeof tools.exec]",
		);
		const constructor = await evaluate(
			'return Object.getPrototypeOf(Object).constructor("return typeof process")()',
		);
		await evaluate("globalThis.leaked = 42; return null");
		const fresh = await evaluate("return typeof leaked");
		await fails("fuel", "while(true) {}", { fuel: 8 });
		await fails("jobs", "while(true) { await Promise.resolve(); }", {
			maxJobs: 128,
		});
		await fails("heap", "return new Array(10000000).fill(42)", {
			heapBytes: 2 * 1024 * 1024,
		});
		await fails("module", 'return import("node:fs")');
		await fails("escape", 'return import("../../../outside.mjs")');
		await fails("result", 'return "x".repeat(200000)');
		await fails("deadPromise", "return new Promise(() => {})");
		return {
			isolated,
			constructor,
			fresh,
			errors,
			recovered: await evaluate("return 42"),
			budget: component.budget(),
		};
	} finally {
		await component.close();
	}
}

/** Concurrent nested effects and incremental observations cross the real guest boundary. */
export async function durableWorkflow(wasmModule: WebAssembly.Module) {
	let harness: Harness;
	const component = createWorkerCode({
		wasmModule,
		cancelTask: (id, ctx) => harness.abortTask(id, ctx),
	});
	const registry = createRegistry();
	const models = createModels();
	const provider = fauxProvider();
	models.setProvider(provider.provider);
	let active = 0,
		maxActive = 0,
		effects = 0;
	const observations: ToolResultMessage[] = [];
	const tool = defineTool({
		name: "ordinary-tool",
		description: "Doubles numbers",
		parameters: Type.Object({ n: Type.Number() }),
		replay: "unsafe",
		prepareArguments: (args) => {
			if (typeof args === "string") return { n: Number(args) };
			if (
				args !== null &&
				typeof args === "object" &&
				"n" in args &&
				typeof args.n === "number"
			)
				return { n: args.n };
			throw new Error("ordinary-tool requires a number");
		},
		async execute(args) {
			effects++;
			active++;
			maxActive = Math.max(maxActive, active);
			try {
				await new Promise((resolve) => setTimeout(resolve, 20));
				return {
					details: { doubled: args.n * 2 },
				};
			} finally {
				active--;
			}
		},
	});
	const ordinary = {
		name: "ordinary",
		tools: [tool],
	};
	const source =
		'export async function execute(args) { const results=await Promise.all([tools["ordinary-tool"]({n:args.n}),tools["ordinary-tool"]("2")]); return {details:{results,version:1}}; }';
	const editable = {
		name: "editable",
		tools: [
			defineTool({
				name: "site_editable",
				description: "Editable guest",
				parameters: Type.Object({ n: Type.Number() }),
				replay: "unsafe",
				async execute(args, api, ctx) {
					return component.executeToolModule(
						{
							entry,
							exportName: "execute",
							args,
							modules: { [entry]: source },
						},
						api,
						ctx,
						{ allowedTools: ["ordinary-tool", "exec", "wait"] },
					);
				},
			}),
		],
	};
	registry.install(component.extension);
	registry.install(ordinary);
	registry.install(editable);
	const code = `
		await text("before");
		await yield_control();
		const nested = await tools.site_editable({n:21});
		await text(nested);
	`;
	provider.setResponses([
		() =>
			fauxAssistantMessage(fauxToolCall("exec", { code }), {
				stopReason: "toolUse",
			}),
		(request) => {
			const result = request.messages.findLast(
				(message) => message.role === "toolResult",
			);
			if (result?.role !== "toolResult")
				throw new Error("Missing yielded result");
			observations.push(result);
			const details = result.details;
			if (!details || typeof details !== "object" || !("cellId" in details))
				throw new Error("Missing cell details");
			return fauxAssistantMessage(
				fauxToolCall("wait", {
					cell_id: String(details["cellId"]),
					yield_time_ms: 0,
				}),
				{ stopReason: "toolUse" },
			);
		},
		(request) => {
			const result = request.messages.findLast(
				(message) => message.role === "toolResult",
			);
			if (result?.role !== "toolResult")
				throw new Error("Missing running result");
			observations.push(result);
			const details = result.details;
			if (!details || typeof details !== "object" || !("cellId" in details))
				throw new Error("Missing cell details");
			return fauxAssistantMessage(
				fauxToolCall("wait", {
					cell_id: String(details["cellId"]),
					yield_time_ms: 1000,
				}),
				{ stopReason: "toolUse" },
			);
		},
		(request) => {
			const result = request.messages.findLast(
				(message) => message.role === "toolResult",
			);
			if (result?.role === "toolResult") observations.push(result);
			return fauxAssistantMessage("done");
		},
	]);
	harness = await Harness.open(
		new MemoryStorage(),
		{ models, registry, settings: { retry: { enabled: false } } },
		context,
	);
	component.bind(harness);
	try {
		const root = await harness.root(context, {
			agent: {
				model: { provider: "faux", modelId: "faux-1" },
				extensions: registry.snapshot().installed(),
			},
		});
		const receipt = await (
			await root.submit(
				{ type: "input", content: "run worker workflow" },
				context,
			)
		).wait(context);
		return {
			observations,
			effects,
			maxActive,
			receipt,
			budget: component.budget(),
		};
	} finally {
		await component.close();
		await harness.close(context);
	}
}

export async function cancellationWorkflow(
	wasmModule: WebAssembly.Module,
	terminate = false,
) {
	let harness: Harness;
	let started = 0,
		cancelled = 0;
	let ready!: () => void;
	const pending = new Promise<void>((resolve) => {
		ready = resolve;
	});
	const registry = createRegistry();
	const models = createModels();
	const provider = fauxProvider();
	models.setProvider(provider.provider);
	const component = createWorkerCode({
		wasmModule,
		cancelTask: (id, ctx) => harness.abortTask(id, ctx),
	});
	registry.install(component.extension);
	registry.install({
		name: "owned",
		tools: [
			defineTool({
				name: "owned_effect",
				description: "Wait for cancellation",
				parameters: Type.Object({}),
				replay: "unsafe",
				async execute(_args, _api, ctx) {
					started++;
					ready();
					await new Promise<never>((_resolve, reject) => {
						const abort = () => {
							cancelled++;
							reject(ctx.abortSignal?.reason);
						};
						ctx.abortSignal?.addEventListener("abort", abort, { once: true });
						if (ctx.abortSignal?.aborted) abort();
					});
					return {};
				},
			}),
			defineTool({
				name: "site_wait",
				description: "Impure guest cancellation",
				parameters: Type.Object({}),
				replay: "unsafe",
				async execute(_args, api, ctx) {
					return component.executeToolModule(
						{
							entry,
							exportName: "execute",
							args: {},
							modules: {
								[entry]:
									"export async function execute() {return await tools.owned_effect({});}",
							},
						},
						api,
						ctx,
						{ allowedTools: ["owned_effect"] },
					);
				},
			}),
		],
	});
	const observations: ToolResultMessage[] = [];
	provider.setResponses([
		() =>
			fauxAssistantMessage(
				fauxToolCall("exec", {
					code: `${terminate ? "await yield_control();" : ""} await tools.site_wait({});`,
				}),
				{ stopReason: "toolUse" },
			),
		async (request) => {
			await pending;
			const result = request.messages.findLast(
				(message) => message.role === "toolResult",
			);
			if (
				result?.role !== "toolResult" ||
				!result.details ||
				typeof result.details !== "object" ||
				!("cellId" in result.details)
			)
				throw new Error("Missing yielded cell ID");
			return fauxAssistantMessage(
				fauxToolCall("wait", {
					cell_id: String(result.details["cellId"]),
					terminate: true,
				}),
				{ stopReason: "toolUse" },
			);
		},
		(request) => {
			const result = request.messages.findLast(
				(message) => message.role === "toolResult",
			);
			if (result?.role === "toolResult") observations.push(result);
			return fauxAssistantMessage("terminated");
		},
	]);
	harness = await Harness.open(
		new MemoryStorage(),
		{ models, registry, settings: { retry: { enabled: false } } },
		context,
	);
	component.bind(harness);
	try {
		const root = await harness.root(context, {
			agent: {
				model: { provider: "faux", modelId: "faux-1" },
				extensions: registry.snapshot().installed(),
			},
		});
		const submission = await root.submit(
			{ type: "input", content: "cancel nested guest" },
			context,
		);
		await pending;
		if (!terminate) await root.abort(context);
		const receipt = await submission.wait(context);
		return {
			started,
			cancelled,
			observations,
			receipt,
			inspection: await harness.inspect(context),
			budget: component.budget(),
		};
	} finally {
		await component.close();
		await harness.close(context);
	}
}
