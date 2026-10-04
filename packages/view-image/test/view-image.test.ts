import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Context } from "@earendil-works/chord";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type JsonObject,
} from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import sharp from "sharp";
import { createViewImageTool } from "../src/index.ts";

const context: Context = {
	abortSignal: undefined,
	value: () => undefined,
	toString: () => "view-image test",
};

async function runTool(
	cwd: string,
	args: JsonObject,
	vision: boolean,
	describe: boolean,
	description: string | "error" = "A red square",
) {
	const faux = fauxProvider({
		models: [
			{ id: "caller", input: vision ? ["text", "image"] : ["text"] },
			{ id: "gpt-6-luna", input: ["text", "image"], reasoning: true },
		],
	});
	const models = createModels();
	models.setProvider(faux.provider);
	const tool = createViewImageTool({ models, describeForTextModels: describe });
	const registry = createRegistry<ReturnType<typeof createViewImageTool>>();
	registry.install({ name: "images", tools: [tool] });
	const harness = await Harness.open(
		new MemoryStorage(),
		{ models, registry, env: () => new NodeExecutionEnv({ cwd }) },
		context,
	);
	try {
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("view_image", args), {
				stopReason: "toolUse",
			}),
			...(describe && !vision
				? [
						(
							_transcript: unknown,
							options: { reasoning?: string; signal?: AbortSignal } | undefined,
						) => {
							assert.equal(options?.reasoning, "low");
							return description === "error"
								? fauxAssistantMessage("", {
										stopReason: "error",
										errorMessage: "description unavailable",
									})
								: fauxAssistantMessage(description);
						},
					]
				: []),
			fauxAssistantMessage("done"),
		]);
		const conversation = await harness.root(context, {
			agent: { model: { provider: "faux", modelId: "caller" } },
		});
		const submission = await conversation.submit(
			{ type: "input", content: "Inspect image" },
			context,
		);
		await submission.wait(context);
		const view = await conversation.context(context);
		const result = view.messages.find(
			(message) => message.role === "toolResult",
		);
		assert.ok(
			result && result.role === "toolResult",
			"Durable should record a tool result",
		);
		return { result, entries: view.entries };
	} finally {
		await harness.close(context);
	}
}

test("Durable registration repairs aliases, uses conversation env, follows symlinks, and retains original bytes", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "view-image-"));
	try {
		const bytes = await sharp({
			create: { width: 3, height: 2, channels: 4, background: "red" },
		})
			.png()
			.toBuffer();
		await writeFile(join(cwd, "image.data"), bytes);
		await symlink("image.data", join(cwd, "link"));
		for (const args of [
			{ path: "@image.data", file_path: "ignored" },
			{ file_path: "link", detail: "original" },
			{ image_path: "image.data", detail: null },
		]) {
			const { result } = await runTool(cwd, args, true, false);
			assert.equal(result.isError, false);
			assert.deepEqual(result.content, [
				{
					type: "image",
					data: bytes.toString("base64"),
					mimeType: "image/png",
				},
			]);
		}
		const invalid = [
			{ path: 3, image_path: "image.data" },
			{ path: "image.data", detail: "high" },
			{ path: "image.data", detail: 3 },
		];
		for (const args of invalid) {
			const { result } = await runTool(cwd, args, true, false);
			assert.equal(result.isError, true);
		}
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("nonvision description is opt-in and produces text plus retained image details and visible provider errors", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "view-image-"));
	try {
		const bytes = await sharp({
			create: { width: 2, height: 2, channels: 4, background: "red" },
		})
			.png()
			.toBuffer();
		await writeFile(join(cwd, "red.png"), bytes);
		const disabled = await runTool(cwd, { path: "missing" }, false, false);
		assert.equal(disabled.result.isError, true);
		assert.match(
			JSON.stringify(disabled.result.content),
			/not allowed because you do not support image inputs/,
		);
		const described = await runTool(cwd, { path: "red.png" }, false, true);
		assert.deepEqual(described.result.content, [
			{ type: "text", text: "A red square" },
		]);
		assert.match(JSON.stringify(described.entries), /viewImageDescription/);
		assert.match(
			JSON.stringify(described.entries),
			new RegExp(bytes.toString("base64").replace(/[+]/g, "\\+")),
		);
		for (const description of ["error", " "]) {
			const failure = await runTool(
				cwd,
				{ path: "red.png" },
				false,
				true,
				description,
			);
			assert.equal(failure.result.isError, true);
			assert.match(
				JSON.stringify(failure.result.content),
				/description (failed|returned no text)/,
			);
		}
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("path and decode errors remain tool failures, not image results", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "view-image-"));
	try {
		await writeFile(
			join(cwd, "bad.png"),
			Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		);
		await symlink(".", join(cwd, "directory-link"));
		for (const [path, error] of [
			["missing", /unable to locate image/],
			["directory-link", /is not a file/],
			["bad.png", /unable to process image/],
		] as const) {
			const { result } = await runTool(cwd, { path }, true, false);
			assert.equal(result.isError, true);
			assert.match(JSON.stringify(result.content), error);
			assert.match(JSON.stringify(result.content), new RegExp(cwd));
		}
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
