import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
	hook,
	MemoryStorage,
	ToolTask,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Type } from "typebox";
import {
	createCodeMode,
	createNodeCommandBackend,
	createNodeShellBackend,
	loadCustomCommandTools,
} from "../src/index.ts";

test("ordinary Durable registration executes inside V8 through a conversation-owned yielded cell", {
	timeout: 180_000,
}, async () => {
	const context = BACKGROUND_CONTEXT;
	const directory = await mkdtemp(join(tmpdir(), "durable-code-integration-"));
	const files = new NodeExecutionEnv({ cwd: directory });
	await writeFile(
		join(directory, "custom.mjs"),
		'process.stdout.write("fromCustom:"+process.argv[2])',
	);
	await writeFile(
		join(directory, "replacement.mjs"),
		'process.stdout.write("liveCustom:"+process.argv[2])',
	);
	await writeFile(
		join(directory, "custom.toml"),
		'usage="await tools.custom(input)"\ncommand="./custom.mjs"\ndefer_loading=false\noutput="string"\n',
	);
	const custom = await loadCustomCommandTools(
		{
			files,
			backend: createNodeCommandBackend({ environmentId: files.id }),
			roots: [{ path: directory, trusted: true }],
		},
		context,
	);
	const models = createModels();
	const faux = fauxProvider();
	models.setProvider(faux.provider);
	let effects = 0;
	const hookModels: boolean[] = [];
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
		async execute(args, api) {
			assert.equal(api.models, models);
			assert.equal(
				api.models.getModel("faux", "faux-1"),
				models.getModel("faux", "faux-1"),
			);
			effects++;
			await writeFile(
				join(directory, "custom.toml"),
				'usage="await tools.custom(input)"\ncommand="./replacement.mjs"\n',
			);
			await new Promise((resolve) => setTimeout(resolve, 50));
			return { details: { doubled: args.n * 2 } };
		},
	});
	const registry = createRegistry();
	const ordinary = {
		name: "ordinary",
		tools: [tool],
		hooks: [
			hook(ToolTask, {
				beforeTool(call, api) {
					if (call.name === tool.name) hookModels.push(api.models === models);
				},
				afterTool(call, _result, api) {
					if (call.name === tool.name) hookModels.push(api.models === models);
				},
			}),
		],
	};
	registry.install(component.extension);
	registry.install(ordinary);
	registry.install(custom.extension);
	const results: ToolResultMessage[] = [];
	faux.setResponses(
		Array.from({ length: 10 }, () => (request) => {
			const offered = request.messages
				.filter((message) => message.role === "system")
				.flatMap((message) => message.toolsAdded ?? []);
			assert.ok(
				!offered.some(
					(tool) =>
						tool.name === "ordinary" ||
						tool.name === "exec_command" ||
						tool.name === "custom",
				),
			);
			assert.match(
				JSON.stringify(request.messages),
				/await tools.custom\(input\)/,
			);
			const last = request.messages.findLast(
				(message) => message.role !== "system",
			);
			if (last?.role !== "toolResult")
				return fauxAssistantMessage(
					fauxToolCall("exec", {
						code: '// @exec: {"yield_time_ms":0}\ntext(await tools.ordinary("21")); text(ALL_TOOLS.find(t=>t.name==="custom")); const customValue=await tools.custom("input"); text(typeof customValue); text(customValue); store("persist", {ok:true}); notify("progress")',
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
				extensions: [component.extension, ordinary, custom.extension],
			},
		});
		await (await root.submit({ type: "input", content: "run" }, context)).wait(
			context,
		);
		assert.equal(effects, 1);
		assert.deepEqual(hookModels, [true, true]);
		assert.equal(results.length, 1);
		assert.match(JSON.stringify(results[0]?.content), /42/);
		assert.match(JSON.stringify(results[0]?.content), /liveCustom:input/);
		assert.match(JSON.stringify(results[0]?.content), /Schema:.*string/);
		assert.ok(
			results[0]?.content.some(
				(item) => item.type === "text" && item.text === "string",
			),
		);
		assert.match(JSON.stringify(results[0]?.details), /ordinary/);
	} finally {
		await component.close();
		await harness.close(context);
		await rm(directory, { recursive: true, force: true });
	}
});
