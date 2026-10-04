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
	Harness,
	MemoryStorage,
} from "@earendil-works/pi-durable";
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
						.filter((text) => /^[AXB]+$/.test(text)),
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
		harness = await Harness.open(
			new MemoryStorage(),
			{ models, registry, settings: { retry: { enabled: false } } },
			context,
		);
		try {
			const root = await harness.root(context, {
				agent: {
					model: { provider: "faux", modelId: "faux-1" },
					extensions: [component.extension],
				},
			});
			await (
				await root.submit({ type: "input", content: "run" }, context)
			).wait(context);
			assert.deepEqual(delivered, scenario.expected);
		} finally {
			await component.close();
			await harness.close(context);
		}
	});
}
