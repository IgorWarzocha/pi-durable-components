import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
	Harness,
	MemoryStorage,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { skills } from "../src/index.ts";

test("bounded skill output retains its continuation footer through Durable", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "skills-registration-"));
	t.after(() => rmSync(cwd, { force: true, recursive: true }));
	mkdirSync(join(cwd, "library/bulk"), { recursive: true });
	writeFileSync(
		join(cwd, "library/bulk/SKILL.md"),
		`---\nname: bulk\ndescription: Bulk\n---\n${"instruction\n".repeat(9000)}`,
	);
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	registry.install(skills({ globalRoot: "library", guidance: true }));
	const harness = await Harness.open(
		new MemoryStorage(),
		{ models, registry, env: () => new NodeExecutionEnv({ cwd }) },
		BACKGROUND_CONTEXT,
	);
	t.after(() => harness.close(BACKGROUND_CONTEXT));
	const model = faux.getModel();
	const conversation = await harness.root(BACKGROUND_CONTEXT, {
		agent: { model: { provider: model.provider, modelId: model.id } },
	});
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("skills", { command: "read bulk" }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("done"),
	]);
	const submission = await conversation.submit(
		{ type: "input", content: "test tools" },
		BACKGROUND_CONTEXT,
	);
	const settled = await submission.wait(BACKGROUND_CONTEXT);
	assert.equal(settled.status, "done");
	const view = await conversation.context(BACKGROUND_CONTEXT);
	const results = view.messages.filter(
		(message) => message.role === "toolResult",
	);
	assert.equal(results.length, 1);
	const output =
		results[0]?.content
			.filter((item) => item.type === "text")
			.map((item) => item.text)
			.join("") ?? "";
	assert.ok(Buffer.byteLength(output) <= 49152);
	assert.match(output, /Continue with command:\nread bulk --offset \d+$/);
});
