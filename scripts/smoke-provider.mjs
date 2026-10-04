import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
	createRegistry,
	defineTool,
	Harness,
	MemoryStorage,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Type } from "typebox";
import {
	createCodeMode,
	createNodeShellBackend,
} from "../packages/code/src/index.ts";
import { createOpenAIResponsesProvider } from "../packages/openai-responses/src/index.ts";

const { values } = parseArgs({
	options: {
		credentials: { type: "string" },
		model: { type: "string", default: "gpt-6-luna" },
	},
});
if (!values.credentials)
	throw new Error(
		"Pass --credentials /path/to/auth.json. This smoke makes real model requests.",
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
		"Supply a Codex OAuth credential with at least ten minutes remaining. Credentials are never refreshed or persisted.",
	);
}
const credentials = new InMemoryCredentialStore();
await credentials.modify("openai-codex", async () => credential);
const context = BACKGROUND_CONTEXT;
const directory = await mkdtemp(join(tmpdir(), "durable-provider-live-"));
try {
	for (const mode of ["native-sse", "code-websocket"]) {
		const diagnostics = [];
		const provider = createOpenAIResponsesProvider({
			transport: mode === "native-sse" ? "sse" : "websocket-cached",
			diagnostics: (event) => diagnostics.push(event),
		});
		const models = createModels({ credentials });
		models.setProvider(provider);
		assert.ok(
			models.getModel(provider.id, values.model),
			"Model missing from provider catalog",
		);
		const env = new NodeExecutionEnv({ cwd: directory });
		let harness;
		let code;
		let effects = 0;
		const calculation = {
			name: "calculation",
			tools: [
				defineTool({
					name: "double_number",
					description: "Double a number",
					parameters: Type.Object({ value: Type.Number() }),
					replay: "unsafe",
					async execute({ value }) {
						effects++;
						return { content: [{ type: "text", text: String(value * 2) }] };
					},
				}),
			],
		};
		const registry = createRegistry();
		const extensions = [];
		if (mode === "code-websocket") {
			code = createCodeMode({
				shell: { backend: createNodeShellBackend({ environmentId: env.id }) },
				cancelTask: (id, ctx) => harness.abortTask(id, ctx),
			});
			extensions.push(code.extension);
		} else extensions.push(calculation);
		for (const extension of extensions) registry.install(extension);
		try {
			harness = await Harness.open(
				new MemoryStorage(),
				{
					models,
					registry,
					env: () => env,
					settings: {
						retry: { enabled: false },
						compaction: { enabled: false },
					},
				},
				context,
			);
			code?.bind(harness);
			const conversation = await harness.root(context, {
				agent: {
					model: { provider: provider.id, modelId: values.model },
					extensions,
				},
			});
			const timer = setTimeout(() => {
				void conversation.abort(context);
			}, 120_000);
			try {
				const request =
					mode === "native-sse"
						? "Call double_number exactly once with value 21. Then answer only with its result."
						: "Call exec exactly once with this JavaScript: text(21 * 2). Then answer only with its result.";
				const result = await (
					await conversation.submit(
						{ type: "input", content: request },
						context,
					)
				).wait(context);
				assert.equal(result.status, "done", JSON.stringify(result));
				const transcript = await conversation.context(context);
				const toolName = mode === "native-sse" ? "double_number" : "exec";
				const receipts = transcript.messages.filter(
					(message) =>
						message.role === "toolResult" && message.toolName === toolName,
				);
				assert.equal(receipts.length, 1, "Expected exactly one executed tool");
				assert.equal(receipts[0].isError, false);
				assert.match(JSON.stringify(receipts[0].content), /42/);
				if (mode === "native-sse") assert.equal(effects, 1);
				const followup = await (
					await conversation.submit(
						{
							type: "input",
							content: "Without using tools, repeat that result.",
						},
						context,
					)
				).wait(context);
				assert.equal(followup.status, "done", JSON.stringify(followup));
				assert.equal(
					diagnostics.filter((event) => event.type === "usage").length,
					3,
				);
				assert.ok(
					diagnostics.every(
						(event) => event.type !== "failure" && event.type !== "fallback",
					),
				);
				console.log(JSON.stringify({ mode, diagnostics }));
			} finally {
				clearTimeout(timer);
			}
		} finally {
			await code?.close();
			await harness?.close(context);
			await provider.close();
		}
	}
} finally {
	await rm(directory, { recursive: true, force: true });
}
