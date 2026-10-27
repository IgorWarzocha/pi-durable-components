import { randomUUID } from "node:crypto";
import { type Context, copyJson } from "@earendil-works/chord";
import {
	defineDoc,
	type JsonObject,
	type ToolExecutionApi,
	type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import type {
	CellEngine,
	CellEngineApi,
} from "../../execution/src/cell-contract.ts";
import { readToolContract } from "../../execution/src/tool-contract.ts";
import { toolValue } from "../../execution/src/tool-value.ts";
import { JsNotebookClient } from "./client.ts";
import type {
	NotebookControlRequest,
	NotebookControlResult,
	NotebookToolDefinition,
	RuntimeContentItem,
	RuntimeResponse,
	ToolExecutionContext,
} from "./runtime-contract.ts";

export interface JsNotebookEngineOptions {
	stateDirectory: string;
	/** Explicit permission to run native workers and access project checkpoint files. */
	native: { environmentId: string };
	maxHeapMiB?: number | undefined;
	profile?: string | undefined;
}

// Conversation identity scopes cell ownership. Project state is deliberately
// shared by cwd beneath the explicitly supplied state directory.
const NotebookNamespace = defineDoc<{ id: string }>({
	kind: "howaboua.js-notebook.namespace",
	version: 1,
	scope: "session",
	checkpointWhen: () => true,
	initial: () => ({ id: randomUUID() }),
});

export function createJsNotebookEngine(
	options: JsNotebookEngineOptions,
): CellEngine & {
	control(
		request: NotebookControlRequest,
		api: ToolExecutionApi,
		context: Context,
	): Promise<NotebookControlResult>;
} {
	if (!options.stateDirectory || !options.native?.environmentId)
		throw new Error(
			"Notebook requires a stateDirectory and an explicit native environment",
		);
	const maxHeapMiB = options.maxHeapMiB ?? 4096;
	if (!Number.isSafeInteger(maxHeapMiB) || maxHeapMiB < 128)
		throw new Error("Notebook maxHeapMiB must be an integer of at least 128");
	const clients = new Map<string, JsNotebookClient>();
	let closed = false;
	async function session(api: ToolExecutionApi, hostContext: Context) {
		if (closed) throw new Error("Notebook host is closed");
		const env = api.env;
		if (!env || env.id !== options.native.environmentId)
			throw new Error(
				`Notebook native runtime is bound to environment ${options.native.environmentId}; no matching execution environment is available`,
			);
		const namespace = await api.commit(
			async (tx) => (await tx.doc(NotebookNamespace)).id,
			hostContext,
		);
		const sessionId = `${namespace}:${api.conversationId}`;
		let client = clients.get(sessionId);
		if (!client) {
			client = new JsNotebookClient({
				agentDir: options.stateDirectory,
				maxHeapMiB,
				profile: options.profile,
			});
			clients.set(sessionId, client);
		}
		const context: ToolExecutionContext = {
			cwd: env.cwd,
			sessionContext: { cwd: env.cwd, sessionId },
		};
		return { client, context };
	}
	return {
		async control(request, api, context) {
			const current = await session(api, context);
			return current.client.controlNotebook(
				request,
				current.context,
				context.abortSignal,
			);
		},
		async run(
			input: JsonObject,
			api: CellEngineApi,
			context: Context,
		): Promise<ToolExecutionResult> {
			if (typeof input["code"] !== "string")
				throw new Error("Notebook exec requires code");
			const current = await session(api.toolApi, context);
			const streamed: NonNullable<ToolExecutionResult["output"]> = [];
			let publications = Promise.resolve();
			let publicationFailure: unknown;
			let publishing = false;
			let dirty = false;
			current.context.onUpdate = (update) => {
				streamed.push(...update.content);
				dirty = true;
				if (publishing || publicationFailure !== undefined) return;
				publishing = true;
				// Keep one publication in flight. Bursts coalesce instead of queuing
				// thousands of complete durable output copies behind a slow commit.
				publications = (async () => {
					while (dirty) {
						dirty = false;
						await api.publish({ output: [...streamed] }, context);
					}
				})()
					.catch((error: unknown) => {
						publicationFailure = error;
					})
					.finally(() => {
						publishing = false;
					});
			};
			let yieldPending = false;
			current.context.onYield = async () => {
				yieldPending = true;
			};
			const tools: NotebookToolDefinition[] = api.registrations.map(
				(registration) => {
					const contract = readToolContract(registration);
					return {
						name: registration.name,
						description: contract.description,
						usage: contract.usage,
						help: contract.help,
						...(registration.name === "exec_command" ||
						registration.name === "write_stdin"
							? { textOutput: "plain-command" as const }
							: {}),
						async invoke(input, _context, signal) {
							signal.throwIfAborted();
							const args = copyJson(input === undefined ? null : input, {
								omitUndefinedProperties: true,
							});
							const invoke = api.tools[registration.name];
							if (!invoke)
								throw new Error(`Tool ${registration.name} is not selected`);
							const result = await invoke(args, signal);
							signal.throwIfAborted();
							return toolValue(result);
						},
					};
				},
			);

			const items: RuntimeContentItem[] = [];
			const budget =
				typeof input["max_output_tokens"] === "number"
					? input["max_output_tokens"]
					: 10000;
			let response = await current.client.execute(
				"// @exec: " +
					JSON.stringify({
						yield_time_ms: 100,
						max_output_tokens: budget,
						isolated: input["isolated"] === true,
					}) +
					"\n" +
					input["code"],
				current.context,
				api.signal,
				tools,
			);
			while (true) {
				items.push(...response.contentItems);
				await publications;
				if (publicationFailure !== undefined) throw publicationFailure;
				const result = notebookResponseResult({
					...response,
					contentItems: items,
				});
				await api.publish(result, context);
				if (yieldPending) {
					yieldPending = false;
					await api.requestYield(context);
				}
				if (response.kind !== "yielded") return result;
				response = await current.client.wait(
					response.cellId,
					100,
					current.context,
					api.signal,
				);
				if (response.missingCell)
					throw new Error(
						"Notebook cell was stopped by lifecycle control. External side effects were not rolled back",
					);
			}
		},
		async close() {
			if (closed) return;
			closed = true;
			const settled = await Promise.allSettled(
				[...clients.values()].map((client) => client.shutdown()),
			);
			clients.clear();
			const failed = settled.find((result) => result.status === "rejected");
			if (failed?.status === "rejected") throw failed.reason;
		},
	};
}

function notebookResponseResult(
	response: RuntimeResponse,
): ToolExecutionResult {
	const content: NonNullable<ToolExecutionResult["output"]> = [];
	for (const item of response.contentItems) {
		if (item.type === "input_text" && item.text)
			content.push({ type: "text", text: item.text });
		if (item.type === "input_image") {
			const match = item.image_url?.match(/^data:([^;,]+);base64,(.+)$/s);
			if (match)
				content.push({ type: "image", mimeType: match[1]!, data: match[2]! });
		}
	}
	if (response.kind === "result" && response.errorText)
		content.push({ type: "text", text: response.errorText });
	return {
		output: content,
		...(response.kind === "result" && response.errorText
			? { isError: true }
			: {}),
		details: {
			runtimeCellId: response.cellId,
			...(response.notebookMemory
				? { memory: { ...response.notebookMemory } }
				: {}),
		},
	};
}
