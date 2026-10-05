import { type Context, type JsonValue } from "@earendil-works/chord";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import type {
	CellEngine,
	CellEngineApi,
} from "../../execution/src/cell-contract.ts";
import { readToolContract } from "../../execution/src/tool-contract.ts";
import { type GuestCapabilities, runGuest } from "./guest.ts";
import { type WorkerCodeLimits } from "./limits.ts";
import { guestContent } from "./output.ts";

/** Own all admitted guests, including pure modules and ordinary tool-owned handlers. */
export class WorkerRuntime implements CellEngine {
	private closed = false;
	private readonly active = new Map<AbortController, Promise<unknown>>();
	private readonly wasm: WebAssembly.Module;
	readonly limits: Readonly<WorkerCodeLimits>;
	private readonly modules: () => ReadonlyMap<string, string>;
	constructor(
		wasm: WebAssembly.Module,
		limits: Readonly<WorkerCodeLimits>,
		modules: () => ReadonlyMap<string, string>,
	) {
		this.wasm = wasm;
		this.limits = limits;
		this.modules = modules;
	}

	async evaluate(
		code: string,
		modules: ReadonlyMap<string, string>,
		signal?: AbortSignal,
		capabilities?: GuestCapabilities,
	) {
		if (this.closed) throw new Error("Worker Code is closed");
		const owner = new AbortController();
		const combined = signal
			? AbortSignal.any([owner.signal, signal])
			: owner.signal;
		const work = runGuest(
			this.wasm,
			code,
			modules,
			this.limits,
			combined,
			capabilities,
		);
		this.active.set(owner, work);
		try {
			return await work;
		} finally {
			this.active.delete(owner);
		}
	}

	async run(
		input: Record<string, JsonValue>,
		api: CellEngineApi,
		context: Context,
	): Promise<ToolExecutionResult> {
		if (typeof input["code"] !== "string")
			throw new Error("exec requires JavaScript source");
		// Capture synchronously before interpreter admission can suspend or a workspace reload can occur.
		const modules = this.modules();
		const content: NonNullable<ToolExecutionResult["content"]> = [];
		let revision = 0;
		let publishing = Promise.resolve();
		const snapshot = (): ToolExecutionResult => ({
			content: [...content],
			details: { workerCode: true, revision },
		});
		const enqueue = (operation: () => Promise<void>) => {
			const next = publishing.then(operation);
			publishing = next;
			return next;
		};
		const result = await this.evaluate(input["code"], modules, api.signal, {
			tools: api.tools,
			inventory: api.registrations.map(readToolContract).map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.inputSchema,
				usage: tool.usage,
			})),
			emit: (kind, value) =>
				enqueue(async () => {
					content.push(guestContent(kind, value));
					revision++;
					await api.publish(snapshot(), context);
				}),
			yield: () =>
				enqueue(async () => {
					await api.publish(snapshot(), context);
					await api.requestYield(context);
				}),
		});
		return {
			...snapshot(),
			details: {
				workerCode: true,
				revision: revision + 1,
				polls: result.polls,
				jobs: result.jobs,
				calls: result.calls,
			},
		};
	}

	async close(): Promise<void> {
		this.closed = true;
		for (const owner of this.active.keys())
			owner.abort(new Error("Worker Code closed"));
		await Promise.allSettled(this.active.values());
	}
}
