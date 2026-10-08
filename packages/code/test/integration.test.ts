import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Type } from "typebox";
import { createCodeMode, createNodeShellBackend } from "../src/index.ts";

test("ordinary Durable registration executes inside V8 through a conversation-owned yielded cell", {
	timeout: 180_000,
}, async () => {
	const context = BACKGROUND_CONTEXT;
	const directory = await mkdtemp(join(tmpdir(), "durable-code-integration-"));
	const files = new NodeExecutionEnv({ cwd: directory });
	const models = createModels();
	const faux = fauxProvider();
	models.setProvider(faux.provider);
	let effects = 0;
	let harness: Harness;
	const component = createCodeMode({
		shell: { backend: createNodeShellBackend({ environmentId: files.id }) },
		cancelTask: (id, context) => harness.abortTask(id, context),
		...(process.env["CODE_MODE_HOST"]
			? { hostPath: process.env["CODE_MODE_HOST"] }
			: {}),
	});
	const tool = defineTool({
		name: "ordinary",
		description: "one effect",
		parameters: Type.Object({ n: Type.Number() }),
		prepareArguments: (args) => {
			if (typeof args === "string") return { n: Number(args) };
			if (
				args &&
				typeof args === "object" &&
				"n" in args &&
				typeof args.n === "number"
			)
				return { n: args.n };
			throw new Error("ordinary requires a number");
		},
		replay: "unsafe",
		async execute(args) {
			effects++;
			await new Promise((resolve) => setTimeout(resolve, 50));
			return { details: { doubled: args.n * 2 } };
		},
	});
	const registry = createRegistry();
	const ordinary = {
		name: "ordinary",
		tools: [tool],
	};
	registry.install(component.extension);
	registry.install(ordinary);
	const results: ToolResultMessage[] = [];
	faux.setResponses(
		Array.from({ length: 10 }, () => (request) => {
			const offered = request.messages
				.filter((message) => message.role === "system")
				.flatMap((message) => message.toolsAdded ?? []);
			assert.ok(
				!offered.some(
					(tool) => tool.name === "ordinary" || tool.name === "exec_command",
				),
			);
			const last = request.messages.findLast(
				(message) => message.role !== "system",
			);
			if (last?.role !== "toolResult")
				return fauxAssistantMessage(
					fauxToolCall("exec", {
						code: '// @exec: {"yield_time_ms":0}\ntext(await tools.ordinary("21"));',
					}),
					{ stopReason: "toolUse" },
				);
			const details = last.details;
			if (
				details &&
				typeof details === "object" &&
				!Array.isArray(details) &&
				"status" in details &&
				details["status"] === "running"
			) {
				return fauxAssistantMessage(
					fauxToolCall("wait", {
						cell_id: String(details["cellId"]),
						yield_time_ms: 1000,
					}),
					{ stopReason: "toolUse" },
				);
			}
			results.push(last);
			return fauxAssistantMessage("done");
		}),
	);
	harness = await Harness.open(
		new MemoryStorage(),
		{
			models,
			registry,
			env: () => files,
			settings: { retry: { enabled: false } },
		},
		context,
	);
	try {
		const root = await harness.root(context, {
			agent: {
				model: { provider: "faux", modelId: "faux-1" },
				extensions: [component.extension, ordinary],
			},
		});
		await (await root.submit({ type: "input", content: "run" }, context)).wait(
			context,
		);
		assert.equal(effects, 1);
		assert.equal(results.length, 1);
		assert.match(JSON.stringify(results[0]?.content), /42/);
		assert.match(JSON.stringify(results[0]?.details), /ordinary/);
	} finally {
		await component.close();
		await harness.close(context);
		await rm(directory, { recursive: true, force: true });
	}
});
