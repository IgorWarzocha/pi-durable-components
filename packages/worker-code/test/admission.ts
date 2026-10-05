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
import { createWorkerCode } from "../src/index.ts";

const context = BACKGROUND_CONTEXT;

/** Multiple Harness owners share one imported memory and fail fast instead of queuing nested guests. */
export async function admissionWorkflow(wasmModule: WebAssembly.Module) {
	const passes = [];
	for (const heapBytes of [8 * 1024 * 1024, 4 * 1024 * 1024]) {
		const capacity = heapBytes === 8 * 1024 * 1024 ? 3 : 4;
		const owners = [];
		const observations: ToolResultMessage[] = [];
		let started = 0,
			cancelled = 0;
		try {
			for (let i = 0; i <= capacity; i++) {
				let harness: Harness;
				const component = createWorkerCode({
					wasmModule,
					limits: { heapBytes },
					cancelTask: (id, ctx) => harness.abortTask(id, ctx),
				});
				const registry = createRegistry();
				const models = createModels();
				const provider = fauxProvider();
				models.setProvider(provider.provider);
				registry.install(component.extension);
				registry.install({
					name: "hold",
					tools: [
						defineTool({
							name: "hold",
							description: "Owned wait",
							parameters: Type.Object({}),
							replay: "unsafe",
							async execute(_args, _api, ctx) {
								started++;
								await new Promise<never>((_resolve, reject) => {
									const abort = () => {
										cancelled++;
										reject(ctx.abortSignal?.reason);
									};
									ctx.abortSignal?.addEventListener("abort", abort, {
										once: true,
									});
									if (ctx.abortSignal?.aborted) abort();
								});
								return {};
							},
						}),
					],
				});
				provider.setResponses([
					() =>
						fauxAssistantMessage(
							fauxToolCall("exec", { code: "await tools.hold({});" }),
							{ stopReason: "toolUse" },
						),
					(request) => {
						const result = request.messages.findLast(
							(message) => message.role === "toolResult",
						);
						if (result?.role === "toolResult") observations.push(result);
						return fauxAssistantMessage("admission failed");
					},
				]);
				harness = await Harness.open(
					new MemoryStorage(),
					{ models, registry, settings: { retry: { enabled: false } } },
					context,
				);
				component.bind(harness);
				const root = await harness.root(context, {
					agent: {
						model: { provider: "faux", modelId: "faux-1" },
						extensions: registry.snapshot().installed(),
					},
				});
				const submission = await root.submit(
					{ type: "input", content: "bounded admission" },
					context,
				);
				owners.push({ harness, component, root, submission });
			}
			await Promise.any(owners.map((owner) => owner.submission.wait(context)));
			const budget = owners[0]?.component.budget();
			await Promise.all(owners.map((owner) => owner.root.abort(context)));
			passes.push({
				heapBytes,
				capacity,
				started,
				cancelled,
				observations,
				budget,
				after: owners[0]?.component.budget(),
			});
		} finally {
			await Promise.all(
				owners.map(async (owner) => {
					await owner.component.close();
					await owner.harness.close(context);
				}),
			);
		}
	}
	return passes;
}
