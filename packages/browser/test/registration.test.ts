import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
import { BrowserArtifacts } from "../src/browser/artifacts.ts";
import { isRecordValue } from "../src/browser/parse-operation.ts";
import { createBrowserExtension, nodeArtifactStore } from "../src/index.ts";

test("Durable preserves complete browser batch JSON and every continuation cursor", async () => {
	const directory = await mkdtemp(join(tmpdir(), "durable-browser-batch-"));
	const context = BACKGROUND_CONTEXT;
	const env = new NodeExecutionEnv({ cwd: directory });
	const native = join(directory, "native");
	const browser = createBrowserExtension({
		stateDirectory: native,
		artifacts: nodeArtifactStore(native),
	});
	let harness: Harness | undefined;
	try {
		const artifacts = new BrowserArtifacts(
			nodeArtifactStore(join(directory, ".pi", "browser")),
		);
		const sources = ["first ".repeat(10_000), "second ".repeat(10_000)];
		const handles: string[] = [];
		for (const source of sources) {
			const cached = await artifacts.limitedText({}, "value", source);
			assert.equal(cached["truncated"], true);
			handles.push(String(cached["result_handle"]));
		}
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const registry = createRegistry();
		registry.install(browser.extension);
		harness = await Harness.open(
			new MemoryStorage(),
			{ models, registry, env: () => env },
			context,
		);
		const model = faux.getModel();
		const conversation = await harness.root(context, {
			agent: {
				model: { provider: model.provider, modelId: model.id },
				extensions: [browser.extension],
			},
		});
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("browser", {
					command: JSON.stringify({
						read_result: handles.map((handle) => ({ handle, offset: 0 })),
					}),
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		const settled = await (
			await conversation.submit(
				{ type: "input", content: "read cached browser results" },
				context,
			)
		).wait(context);
		assert.equal(settled.status, "done");
		const view = await conversation.context(context);
		const result = view.messages.find(
			(message) => message.role === "toolResult",
		);
		assert.ok(result?.role === "toolResult");
		assert.equal(result.isError, false);
		const text = result.content
			.filter((item) => item.type === "text")
			.map((item) => item.text)
			.join("");
		assert.ok(Buffer.byteLength(text) > 50 * 1024);
		const parsed: unknown = JSON.parse(text);
		assert.ok(isRecordValue(parsed));
		assert.ok(Array.isArray(parsed["results"]));
		const items: unknown[] = parsed["results"];
		assert.equal(items.length, 2);
		for (const [index, item] of items.entries()) {
			assert.ok(isRecordValue(item));
			assert.equal(item["handle"], handles[index]);
			assert.equal(item["complete"], false);
			assert.equal(typeof item["text"], "string");
			assert.equal(typeof item["next_offset"], "number");
			assert.equal(
				item["text"],
				sources[index]?.slice(0, Number(item["next_offset"])),
			);
		}
		assert.deepEqual(result.details, parsed);
	} finally {
		await browser.close();
		await harness?.close(context);
		await env.cleanup(context);
		await rm(directory, { recursive: true, force: true });
	}
});
