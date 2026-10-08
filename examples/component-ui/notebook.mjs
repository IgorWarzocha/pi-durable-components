import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	createRegistry,
	Harness,
	MemoryStorage,
	ToolTask,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { notebookCapability } from "@howaboua/pi-durable-notebook/presentation";
import {
	createNodeShellBackend,
	createNotebookMode,
} from "../../packages/notebook/dist/index.js";
import { stateSource } from "./channel.mjs";

export async function notebookChannel(cwd, stateDirectory) {
	const env = new NodeExecutionEnv({ cwd });
	const registry = createRegistry();
	let harness;
	const mode = createNotebookMode({
		stateDirectory,
		native: { environmentId: env.id },
		shell: { backend: createNodeShellBackend({ environmentId: env.id }) },
		cancelTask: (id, context) => harness.abortTask(id, context),
	});
	registry.install(mode.extension);
	harness = await Harness.open(
		new MemoryStorage(),
		{ registry, models: createModels(), env: () => env },
		BACKGROUND_CONTEXT,
	);
	mode.bind(harness);
	const conversation = await harness.root(BACKGROUND_CONTEXT, {
		agent: { cwd },
	});
	const state = stateSource({ cell: null, result: null });
	let busy = false;
	return {
		...state,
		openStream(name, send) {
			if (name !== "results") throw new Error("Stream not granted");
			return state.subscribe((snapshot) => {
				if (snapshot.value.result !== null) send(snapshot.value.result);
			});
		},
		async call(action, input, { signal }) {
			if (!["exec", "wait", "notebook"].includes(action))
				throw new Error("Action not granted");
			if (busy) throw new Error("A notebook action is already running");
			signal.throwIfAborted();
			busy = true;
			let task;
			let cancellation;
			const cancel = () => {
				if (task && !cancellation) {
					// exec cells are conversation-owned, not children of this ToolTask.
					// This channel owns a dedicated conversation, so cancel that scope and join it.
					cancellation = conversation.abort(BACKGROUND_CONTEXT);
					// Owned below. Attach an observer immediately while the tool wait settles.
					void cancellation.catch(() => {});
				}
			};
			signal.addEventListener("abort", cancel, { once: true });
			try {
				const callId = randomUUID();
				// A host-authored invocation, not a provider response. No model is called.
				task = await conversation.commit(async (tx) => {
					const entry = await tx.appendEntry(AssistantEntry, conversation.id, {
						model: [
							{
								role: "assistant",
								content: [
									{
										type: "toolCall",
										id: callId,
										name: action,
										arguments: input,
									},
								],
								api: "host-ui",
								provider: "host-ui",
								model: "host-ui",
								stopReason: "toolUse",
								timestamp: Date.now(),
								usage: {
									input: 0,
									output: 0,
									cacheRead: 0,
									cacheWrite: 0,
									totalTokens: 0,
									cost: {
										input: 0,
										output: 0,
										cacheRead: 0,
										cacheWrite: 0,
										total: 0,
									},
								},
							},
						],
					});
					return tx.createTask(
						ToolTask,
						{ assistant: entry.id, callId },
						{
							conversationId: conversation.id,
							ownership: { kind: "conversation" },
						},
					);
				}, BACKGROUND_CONTEXT);
				if (signal.aborted) cancel();
				const settled = await harness.waitForTask(task, BACKGROUND_CONTEXT);
				await cancellation;
				if (!settled.state.outcome.result?.entryId)
					throw new Error(`Task ${settled.state.outcome.status}`);
				const entry = await conversation.commit(
					(tx) => tx.entry(settled.state.outcome.result.entryId),
					BACKGROUND_CONTEXT,
				);
				const result = entry.model[0];
				state.publish(
					notebookCapability.parseState({
						cell: result.details?.cell_id
							? { id: result.details.cell_id, status: result.details.status }
							: null,
						result: { ...result, diagnostics: entry.data?.diagnostics ?? [] },
					}),
				);
				return result;
			} catch (error) {
				state.publish(
					notebookCapability.parseState({
						cell: null,
						result: {
							isError: true,
							content: [
								{
									type: "text",
									text: `${String(error)}. Do not replay interrupted side effects automatically.`,
								},
							],
						},
					}),
				);
				throw error;
			} finally {
				signal.removeEventListener("abort", cancel);
				try {
					await cancellation;
				} finally {
					busy = false;
				}
			}
		},
		async close() {
			await conversation.abort(BACKGROUND_CONTEXT);
			await mode.close();
			await harness.close(BACKGROUND_CONTEXT);
		},
	};
}
