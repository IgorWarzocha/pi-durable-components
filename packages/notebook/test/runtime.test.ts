import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import {
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
	MemoryStorage,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Type } from "typebox";
import { NotebookClient } from "../src/client.ts";
import { createNodeShellBackend, createNotebookMode } from "../src/index.ts";
import type {
	RuntimeResponse,
	ToolExecutionContext,
} from "../src/runtime-contract.ts";

test("real Deno restores values without cell replay, owns cancellation, and invokes ordinary Durable tools", {
	timeout: 240000,
}, async () => {
	const root = mkdtempSync(join(tmpdir(), "durable-notebook-"));
	const project = join(root, "project");
	mkdirSync(project);
	const context: ToolExecutionContext = {
		cwd: project,
		sessionContext: { cwd: project, sessionId: "native-smoke" },
	};
	const options = { agentDir: root, maxHeapMiB: 512 };
	let client = new NotebookClient(options);
	try {
		const countPath = join(project, "count");
		await completed(
			client,
			`
      await Deno.writeTextFile(${JSON.stringify(countPath)}, String(Number(await Deno.readTextFile(${JSON.stringify(countPath)}).catch(() => "0")) + 1));
      var retained = {counter:7, map:new Map([["x",11]]), bytes:new Uint8Array([4,5]), big:9n};
      var helper = (value: number) => value + 1;
      helper.description = "increment"; helper.usage = "helper(value)";
    `,
			context,
		);
		await client.controlNotebook({ action: "pin", names: ["helper"] }, context);
		await client.checkpoint();
		await client.shutdown();
		client = new NotebookClient(options);
		const restored = await completed(
			client,
			'text({counter:retained.counter, val:retained.map.get("x"), bytes:[...retained.bytes], big:String(retained.big), result:helper(8), description:helper.description})',
			context,
		);
		assert.match(
			text(restored),
			/"counter":7,"val":11,"bytes":\[4,5\],"big":"9","result":9,"description":"increment"/,
		);
		assert.equal(
			readFileSync(countPath, "utf8"),
			"1",
			"restoration must not repeat the original side effect",
		);
		await client.shutdown();

		// Drive nested cancellation and checkpoint isolation through real Durable tasks.
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const registry = createRegistry();
		const env = new NodeExecutionEnv({ cwd: project });
		let harness: Awaited<ReturnType<typeof Harness.open>>;
		const mode = createNotebookMode({
			stateDirectory: root,
			native: { environmentId: env.id },
			maxHeapMiB: 512,
			shell: { backend: createNodeShellBackend({ environmentId: env.id }) },
			cancelTask: (id, ctx) => harness.abortTask(id, ctx),
		});
		const modes = [mode];
		registry.install(mode.extension);
		let ownedCancelled = false;
		registry.install(
			defineExtension({
				name: "probe",
				tools: [
					defineTool({
						name: "owned",
						description: "Owned task",
						parameters: Type.Object({}),
						async execute(_args, _api, context) {
							return new Promise((_resolve, reject) =>
								context.abortSignal?.addEventListener(
									"abort",
									() => {
										ownedCancelled = true;
										reject(context.abortSignal?.reason);
									},
									{ once: true },
								),
							);
						},
					}),
				],
			}),
		);
		harness = await Harness.open(
			new MemoryStorage(),
			{ models, registry, env: () => env },
			BACKGROUND_CONTEXT,
		);
		try {
			const model = faux.getModel();
			const conversation = await harness.root(BACKGROUND_CONTEXT, {
				agent: { model: { provider: model.provider, modelId: model.id } },
			});
			faux.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("exec", {
							code: "void tools.owned({}); await new Promise(resolve => setTimeout(resolve, 50));",
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			]);
			const submission = await conversation.submit(
				{ type: "input", content: "test notebook" },
				BACKGROUND_CONTEXT,
			);
			assert.equal((await submission.wait(BACKGROUND_CONTEXT)).status, "done");
			const view = await conversation.context(BACKGROUND_CONTEXT);
			const results = view.messages.filter(
				(each) => each.role === "toolResult",
			);
			assert.equal(
				results.length,
				1,
				"nested calls have audit entries, not fabricated model tool results",
			);
			const result = results[0]!;
			assert.equal(result.isError, false);
			assert.equal(
				ownedCancelled,
				true,
				"cell settlement must cancel and join unawaited owned nested work",
			);

			faux.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("exec", {
							code: 'text("before-yield"); await yield_control(); await new Promise(resolve => setTimeout(resolve,1000)); text("after-yield");',
						}),
					],
					{ stopReason: "toolUse" },
				),
				(input) => {
					const result = input.messages
						.filter((each) => each.role === "toolResult")
						.at(-1)!;
					const output = result.content
						.filter((each) => each.type === "text")
						.map((each) => each.text)
						.join("\n");
					assert.match(output, /before-yield/);
					assert.doesNotMatch(output, /after-yield/);
					const id = output.match(/exec cell "([0-9]+)"/)?.[1];
					assert.ok(id, "yielded cell handle must be model-visible");
					return fauxAssistantMessage([fauxToolCall("wait", { cell_id: id })], {
						stopReason: "toolUse",
					});
				},
				(input) => {
					const result = input.messages
						.filter((each) => each.role === "toolResult")
						.at(-1)!;
					const output = result.content
						.filter((each) => each.type === "text")
						.map((each) => each.text)
						.join("\n");
					assert.match(output, /after-yield/);
					assert.doesNotMatch(
						output,
						/before-yield/,
						"wait must not redeliver output already observed by exec",
					);
					return fauxAssistantMessage("done");
				},
			]);
			const yieldedSubmission = await conversation.submit(
				{ type: "input", content: "yield notebook" },
				BACKGROUND_CONTEXT,
			);
			assert.equal(
				(await yieldedSubmission.wait(BACKGROUND_CONTEXT)).status,
				"done",
			);

			faux.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("exec", {
							code: "var privateForkValue = 123;",
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			]);
			const retained = await conversation.submit(
				{ type: "input", content: "retain private value" },
				BACKGROUND_CONTEXT,
			);
			assert.equal((await retained.wait(BACKGROUND_CONTEXT)).status, "done");
			await mode.close();
			const reopened = createNotebookMode({
				stateDirectory: root,
				native: { environmentId: env.id },
				maxHeapMiB: 512,
				shell: { backend: createNodeShellBackend({ environmentId: env.id }) },
				cancelTask: (id, ctx) => harness.abortTask(id, ctx),
			});
			modes.push(reopened);
			registry.install(reopened.extension);
			const other = await harness.createConversation(
				{
					ownership: { kind: "ownerless" },
					agent: { model: { provider: model.provider, modelId: model.id } },
				},
				BACKGROUND_CONTEXT,
			);
			for (const [target, code, expected] of [
				[other, "var privateForkValue = 456; text(privateForkValue)", "456"],
				[conversation, "text(privateForkValue)", "123"],
			] as const) {
				faux.setResponses([
					fauxAssistantMessage([fauxToolCall("exec", { code })], {
						stopReason: "toolUse",
					}),
					fauxAssistantMessage("done"),
				]);
				const run = await target.submit(
					{ type: "input", content: "restore private conversation" },
					BACKGROUND_CONTEXT,
				);
				assert.equal((await run.wait(BACKGROUND_CONTEXT)).status, "done");
				const result = (await target.context(BACKGROUND_CONTEXT)).messages
					.filter((each) => each.role === "toolResult")
					.at(-1)!;
				assert.equal(
					result.isError,
					false,
					"starting another conversation must not delete this private checkpoint",
				);
				assert.match(
					result.content
						.filter((each) => each.type === "text")
						.map((each) => each.text)
						.join("\n"),
					new RegExp(expected),
				);
			}
		} finally {
			await Promise.all(modes.map((mode) => mode.close()));
			await harness.close(BACKGROUND_CONTEXT);
		}
	} finally {
		await client.shutdown();
		rmSync(root, { recursive: true, force: true });
	}
});

async function completed(
	client: NotebookClient,
	code: string,
	context: ToolExecutionContext,
): Promise<RuntimeResponse> {
	let result = await client.execute(code, context);
	const items = [...result.contentItems];
	while (result.kind === "yielded") {
		result = await client.wait(result.cellId, 10000, context);
		items.push(...result.contentItems);
	}
	assert.equal(result.kind, "result");
	if (result.kind === "result")
		assert.equal(
			result.errorText,
			undefined,
			result.errorText ?? "unexpected execution error",
		);
	return { ...result, contentItems: items };
}
function text(result: RuntimeResponse) {
	return result.contentItems
		.filter((each) => each.type === "input_text")
		.map((each) => each.text)
		.join("\n");
}
