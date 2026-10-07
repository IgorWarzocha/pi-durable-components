import assert from "node:assert/strict";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
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
import { createCodeMode, createNodeShellBackend } from "../src/index.ts";

for (const scenario of [
	{
		name: "requested exec output budget survives ordinary Harness limits",
		code: '// @exec: {"max_output_tokens":30000}\ntext("X".repeat(90000))',
		expected: ["X".repeat(90000)],
	},
	{
		name: "wait has a fresh output budget rather than the cell's consumed exec budget",
		code: 'text("A".repeat(30000)); yield_control(); await new Promise(r=>setTimeout(r,100)); text("B".repeat(90000))',
		expected: ["A".repeat(30000), "B".repeat(90000)],
	},
	{
		name: "nested tail snapshots preserve the line boundary margin",
		code: "const r=await tools.bounded_output({skip:false}); text(r.content[0].text)",
		maxBytes: 2,
		expected: ["A"],
		truncated: "Output truncated to its end: 1 lines, 5 bytes dropped",
	},
	{
		name: "nested output accounts for environment skips and preserves later BOM text",
		code: "text(await tools.bounded_output({skip:true}))",
		expected: ["\ufeffXX"],
		truncated: "Output truncated to its end: 11 lines, 101 bytes dropped",
	},
]) {
	test(scenario.name, { timeout: 10_000 }, async () => {
		const context = BACKGROUND_CONTEXT;
		const models = createModels(),
			provider = fauxProvider();
		models.setProvider(provider.provider);
		let harness: Harness;
		const component = createCodeMode({
			shell: { backend: createNodeShellBackend({ environmentId: "local" }) },
			cancelTask: (id, context) => harness.abortTask(id, context),
			...(process.env["CODE_MODE_HOST"]
				? { hostPath: process.env["CODE_MODE_HOST"] }
				: {}),
		});
		const registry = createRegistry();
		registry.install(component.extension);
		const bounded = {
			name: "bounded-output-regression",
			tools: [
				defineTool({
					name: "bounded_output",
					description: "Exercise nested bounded streaming output",
					parameters: Type.Object({ skip: Type.Boolean() }),
					outputLimits: {
						maxBytes: scenario.maxBytes ?? 5,
						maxLines: 2,
						retain: "tail",
					},
					async execute(args, api) {
						assert.deepEqual(api.outputWindow, {
							maxBytes: scenario.maxBytes ?? 5,
							maxLines: 2,
							minIntervalMs: 7,
							bytesPerSecond: 100 * 1024,
						});
						if (args.skip) {
							api.output(new Uint8Array([0xef, 0xbb, 0xbf]));
							api.output(new TextEncoder().encode("\n\ufeffXX"), {
								bytes: 100,
								newlines: 10,
								endsWithNewline: true,
							});
						} else {
							// This character cannot fit. The snapshot still needs its boundary margin:
							// appending a newline must not turn the discarded line into an empty retained line.
							api.output("😀");
							await api.details({ snapshot: true }, context);
							api.output("\nA");
						}
						return {};
					},
				}),
			],
		};
		registry.install(bounded);
		const delivered: string[] = [];
		provider.setResponses(
			Array.from({ length: 8 }, () => (request) => {
				const last = request.messages.findLast(
					(message) => message.role !== "system",
				);
				if (last?.role !== "toolResult")
					return fauxAssistantMessage(
						fauxToolCall("exec", { code: scenario.code }),
						{ stopReason: "toolUse" },
					);
				delivered.push(
					...last.content
						.filter((item) => item.type === "text")
						.map((item) => item.text)
						.filter((text) => /^[ABXYZQ\ufeff]+$/.test(text)),
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
							max_tokens: 30000,
						}),
						{ stopReason: "toolUse" },
					);
				}
				return fauxAssistantMessage("done");
			}),
		);
		const storage = new MemoryStorage();
		harness = await Harness.open(
			storage,
			{
				models,
				registry,
				settings: {
					retry: { enabled: false },
					progress: { outputIntervalMs: 7 },
				},
			},
			context,
		);
		try {
			const root = await harness.root(context, {
				agent: {
					model: { provider: "faux", modelId: "faux-1" },
					extensions: [component.extension, bounded],
				},
			});
			await (
				await root.submit({ type: "input", content: "run" }, context)
			).wait(context);
			assert.deepEqual(delivered, scenario.expected);
			if (scenario.truncated) {
				const entries = await storage.scanEntries(
					{ conversationId: root.id },
					100,
					undefined,
					context,
				);
				const nested = entries.items.find(
					(entry) => entry.kind === "howaboua.execution.nested-result",
				);
				assert.ok(nested);
				assert.ok(JSON.stringify(nested).includes(scenario.truncated));
			}
		} finally {
			await component.close();
			await harness.close(context);
		}
	});
}
