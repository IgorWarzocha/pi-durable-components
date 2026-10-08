import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
	createRegistry,
	Harness,
	MemoryStorage,
	type SettledTask,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
	createCodeMode,
	createNodeShellBackend,
} from "../packages/code/src/index.ts";
import {
	createContextManagement,
	type InputResult,
} from "../packages/context/src/index.ts";
import { createNotebookMode } from "../packages/notebook/src/index.ts";

const context = BACKGROUND_CONTEXT;
type Mode = "code" | "notebook";

test("native context rollover and mode switching preserve isolated V8 and Deno state", {
	timeout: 240_000,
}, async () => {
	const directory = await mkdtemp(join(tmpdir(), "durable-toolkit-"));
	const env = new NodeExecutionEnv({ cwd: directory });
	const storage = new MemoryStorage();
	const models = createModels();
	const faux = fauxProvider({
		models: [{ id: "toolkit", input: ["text", "image"] }],
	});
	models.setProvider(faux.provider);
	const management = createContextManagement({ models });
	let harness: Harness | undefined;
	const cancelTask = (
		id: Parameters<Harness["abortTask"]>[0],
		ctx: Parameters<Harness["abortTask"]>[1],
	) => {
		assert.ok(harness);
		return harness.abortTask(id, ctx);
	};
	const code = createCodeMode({
		shell: { backend: createNodeShellBackend({ environmentId: env.id }) },
		cancelTask,
	});
	const notebook = createNotebookMode({
		stateDirectory: join(directory, "notebook-state"),
		native: { environmentId: env.id },
		maxHeapMiB: 512,
		shell: { backend: createNodeShellBackend({ environmentId: env.id }) },
		cancelTask,
	});
	try {
		const ordinary = [management.extension];
		const registry = createRegistry();
		for (const extension of [...ordinary, code.extension, notebook.extension])
			registry.install(extension);
		const observed: ToolResultMessage[] = [];
		let active: Mode = "code";
		let program = "";
		let call = 0;
		faux.setResponses(
			Array.from({ length: 100 }, () => (request) => {
				const input = request.messages.findLast(
					(message) => message.role === "user",
				);
				const last = request.messages.findLast(
					(message) => message.role !== "system",
				);
				const user = messageText(input);
				const offered = new Set(
					request.messages
						.filter((message) => message.role === "system")
						.flatMap(
							(message) => message.toolsAdded?.map((tool) => tool.name) ?? [],
						),
				);
				assert.deepEqual(
					[...offered].sort(),
					active === "code"
						? ["exec", "new_context", "wait"]
						: ["exec", "new_context", "notebook", "wait"],
					"ordinary tools must fold automatically into the selected execution surface",
				);
				if (last?.role === "toolResult") {
					observed.push(last);
					assert.equal(last.isError, false, messageText(last));
					if (user === `toolkit:${active}:rollover`) {
						return fauxAssistantMessage(
							fauxToolCall("new_context", {}, { id: `rotate-${++call}` }),
							{ stopReason: "toolUse" },
						);
					}
					const details = last.details;
					if (
						details &&
						typeof details === "object" &&
						"status" in details &&
						details["status"] === "running"
					) {
						const id = messageText(last).match(/exec cell "([0-9]+)"/)?.[1];
						assert.ok(id, "the yielded cell handle must be model-visible");
						return fauxAssistantMessage(
							fauxToolCall(
								"wait",
								{ cell_id: id, yield_time_ms: 1000 },
								{ id: `wait-${++call}` },
							),
							{ stopReason: "toolUse" },
						);
					}
					return fauxAssistantMessage("toolkit complete");
				}
				if (user === "Continue from your saved notes.") {
					assert.equal(
						request.messages.some(
							(message) =>
								message.role === "user" &&
								messageText(message).startsWith("toolkit:"),
						),
						false,
						"rollover must remove the old active transcript",
					);
					program =
						active === "code"
							? 'text(load("toolkit"));'
							: "text(toolkitState);";
				}
				return fauxAssistantMessage(
					fauxToolCall("exec", { code: program }, { id: `exec-${++call}` }),
					{ stopReason: "toolUse" },
				);
			}),
		);
		harness = await Harness.open(
			storage,
			{
				models,
				registry,
				env: () => env,
				settings: { retry: { enabled: false } },
			},
			context,
		);
		management.bind(harness, storage);
		code.bind(harness);
		notebook.bind(harness);
		const root = await harness.root(context, {
			agent: {
				model: { provider: faux.getModel().provider, modelId: "toolkit" },
				extensions: [...ordinary, code.extension],
			},
		});
		for (const mode of ["code", "notebook"] as const) {
			active = mode;
			await root.configure(
				{
					extensions: [
						...ordinary,
						mode === "code" ? code.extension : notebook.extension,
					],
				},
				context,
			);
			program =
				mode === "code"
					? 'store("toolkit", {mode:"code",value:42});'
					: 'var toolkitState = {mode:"notebook",value:42};';
			observed.length = 0;
			assert.equal(
				(
					await (
						await root.submit(
							{ type: "input", content: `toolkit:${mode}` },
							context,
						)
					).wait(context)
				).status,
				"done",
			);
			program =
				'text(await tools.notes({action:"write_file",path:"handoff",text:"Retain toolkit state"})); text(ALL_TOOLS.some(t => t.name === "new_context")); try { await tools.new_context({}); throw new Error("nested rollover escaped"); } catch (error) { text(String(error)); }';
			observed.length = 0;
			const rollover = await management.submit(
				root.id,
				{ type: "input", content: `toolkit:${mode}:rollover` },
				context,
			);
			const rolloverResult: SettledTask<InputResult> =
				await harness.waitForTask(rollover, context);
			assert.equal(
				rolloverResult.state.outcome.status,
				"completed",
				JSON.stringify(rolloverResult.state.outcome),
			);
			if (rolloverResult.state.outcome.status === "completed")
				assert.equal(rolloverResult.state.outcome.result.status, "done");
			const rolloverOutput = observed.map(messageText).join("\n");
			assert.match(rolloverOutput, /false/);
			assert.doesNotMatch(rolloverOutput, /nested rollover escaped/);
			assert.match(
				rolloverOutput,
				new RegExp(`"mode":"${mode}"`),
				"the same live execution state must survive the context cut",
			);
		}
		// Both components are installed throughout. Selection switches in one conversation.
		for (const mode of ["code", "notebook"] as const) {
			active = mode;
			await root.configure(
				{
					extensions: [
						...ordinary,
						mode === "code" ? code.extension : notebook.extension,
					],
				},
				context,
			);
			program =
				mode === "code" ? 'text(load("toolkit"));' : "text(toolkitState);";
			observed.length = 0;
			assert.equal(
				(
					await (
						await root.submit(
							{ type: "input", content: `toolkit:${mode}:resume` },
							context,
						)
					).wait(context)
				).status,
				"done",
			);
			assert.match(
				observed.map(messageText).join("\n"),
				new RegExp(`"mode":"${mode}"`),
			);
		}
	} finally {
		await Promise.all([code.close(), notebook.close()]);
		await harness?.close(context);
		await rm(directory, { recursive: true, force: true });
	}
});

function messageText(message: Message | undefined): string {
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	return (
		message.content
			?.filter((item) => item.type === "text")
			.map((item) => item.text)
			.join("\n") ?? ""
	);
}
