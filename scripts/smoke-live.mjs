import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import {
	createRegistry,
	Harness,
	MemoryStorage,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createImageGenerationExtension } from "../packages/imagegen/src/index.ts";
import { createViewImageTool } from "../packages/view-image/src/index.ts";
import { createWebSearchExtension } from "../packages/web/src/index.ts";

const { values } = parseArgs({
	options: {
		credentials: { type: "string" },
		images: { type: "boolean", default: false },
	},
});
if (!values.credentials)
	throw new Error(
		"Pass --credentials /path/to/auth.json. Add --images to make two real image requests.",
	);
const stored = JSON.parse(await readFile(values.credentials, "utf8"));
const credential = stored["openai-codex"];
if (
	credential?.type !== "oauth" ||
	typeof credential.access !== "string" ||
	typeof credential.refresh !== "string" ||
	!Number.isFinite(credential.expires) ||
	credential.expires < Date.now() + 600_000
) {
	throw new Error(
		"Supply a valid openai-codex OAuth credential with at least ten minutes remaining. This smoke does not refresh or modify credentials.",
	);
}
const credentials = new InMemoryCredentialStore();
await credentials.modify("openai-codex", async () => credential);
const models = createModels({ credentials });
models.setProvider(openaiCodexProvider());
const router = fauxProvider({
	models: [{ id: "smoke", input: ["text", "image"] }],
});
models.setProvider(router.provider);
const context = BACKGROUND_CONTEXT;
const directory = await mkdtemp(join(tmpdir(), "durable-live-tools-"));
const env = new NodeExecutionEnv({ cwd: directory });
let harness;
try {
	const extensions = [
		createWebSearchExtension({ models }),
		createImageGenerationExtension({
			models,
			conversation: (id, ctx) => harness.conversation(id, ctx),
		}),
		{ name: "view-image", tools: [createViewImageTool({ models })] },
	];
	const registry = createRegistry();
	for (const extension of extensions) registry.install(extension);
	harness = await Harness.open(
		new MemoryStorage(),
		{
			models,
			registry,
			env: () => env,
			settings: { retry: { enabled: false } },
		},
		context,
	);
	const conversation = await harness.root(context, {
		agent: {
			model: { provider: router.provider.id, modelId: "smoke" },
			extensions,
		},
	});
	// Only model routing is scripted. Every tool executes its real registered implementation and network requests.
	async function call(name, args) {
		let result;
		router.setResponses([
			fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" }),
			(request) => {
				result = request.messages.findLast(
					(message) => message.role === "toolResult",
				);
				return fauxAssistantMessage("done");
			},
		]);
		const timer = setTimeout(() => {
			void conversation.abort(context);
		}, 240_000);
		try {
			await (
				await conversation.submit(
					{ type: "input", content: `Exercise ${name}` },
					context,
				)
			).wait(context);
		} finally {
			clearTimeout(timer);
		}
		assert.ok(result, `${name} returned no result`);
		assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`);
		console.log(`${name}: success, ${result.content.length} content blocks`);
		return result;
	}
	const search = await call("web_run", {
		search_query: [{ q: "TypeScript official documentation" }],
		response_length: "short",
	});
	const searchText = search.content
		.filter((item) => item.type === "text")
		.map((item) => item.text)
		.join("\n");
	assert.match(searchText, /typescript/i);
	const ref = searchText.match(/turn\d+(?:search|view)\d+/)?.[0];
	assert.ok(ref, "Search returned no reusable reference");
	await call("web_run", { open: [{ ref_id: ref }], response_length: "short" });
	if (values.images) {
		const generated = await call("imagegen", {
			prompt:
				"Square 1:1 validation image. A single blue circle centered on white. Flat simple low-detail graphic, no lettering.",
		});
		assert.ok(generated.details?.images?.length);
		const path = generated.details.images[0].absolute_path;
		assert.ok((await stat(path)).size > 0);
		const viewed = await call("view_image", { path, detail: "original" });
		const image = viewed.content.find((item) => item.type === "image");
		assert.ok(image);
		assert.deepEqual(Buffer.from(image.data, "base64"), await readFile(path));
		const edited = await call("imagegen", {
			prompt:
				"Change the blue circle to red. Keep the square 1:1 composition and white background. Flat simple low-detail graphic.",
			num_last_images_to_include: 1,
		});
		assert.ok(edited.details?.images?.length);
		const editedPath = resolve(
			directory,
			edited.details.images[0].absolute_path,
		);
		assert.ok((await stat(editedPath)).size > 0);
		console.log(
			"Generation, native image delivery, byte-preserving view and recent-image editing succeeded.",
		);
	}
} finally {
	await harness?.close(context);
	await rm(directory, { recursive: true, force: true });
}
