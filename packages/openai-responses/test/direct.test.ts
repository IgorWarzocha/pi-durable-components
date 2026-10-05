import assert from "node:assert/strict";
import test from "node:test";
import {
	InMemoryCredentialStore,
	type Model,
	normalizeContext,
} from "@earendil-works/pi-ai";
import {
	stream as stockStream,
	streamSimple as stockStreamSimple,
} from "@earendil-works/pi-ai/api/openai-responses";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { Type } from "typebox";
import { createOpenAIResponsesProvider } from "../src/index.ts";
import { protocolFixture } from "./protocol-fixture.ts";

const user = (content: string) => ({
	role: "user" as const,
	content,
	timestamp: 1,
});

test("direct simple API-key requests preserve stock output-token clamping and additional provider options", {
	timeout: 30_000,
}, async () => {
	const fixture = await protocolFixture();
	const catalogModel = openaiProvider()
		.getModels()
		.find(({ id }) => id === "gpt-6-luna");
	assert.ok(catalogModel);
	const stockModel = { ...catalogModel, contextWindow: 8192 };
	const model = { ...stockModel, baseUrl: `${fixture.baseUrl}/v1` };
	const provider = createOpenAIResponsesProvider({
		mode: "direct",
		models: [model],
	});
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("openai", async () => ({
		type: "api_key",
		key: "sk-local-test",
	}));
	const models = createModels({ credentials });
	models.setProvider(provider);
	const context = { messages: [user("one")] };
	const options = {
		apiKey: "sk-local-test",
		sessionId: "token-cap",
		maxTokens: 99_999,
	};
	try {
		const result = await models.completeSimple(model, context, options);
		assert.equal(
			result.stopReason,
			"stop",
			result.errorMessage ?? "unexpected stop reason",
		);
		const direct = (await fixture.records()).requests[0];
		assert.ok(direct);
		let stockPayload: unknown;
		const stock = await stockStreamSimple(
			stockModel,
			normalizeContext(context),
			{
				...options,
				onPayload: (body) => {
					stockPayload = body;
				},
				fetch: (_url, init) => fetch(`${fixture.baseUrl}/v1/responses`, init),
			},
		).result();
		assert.equal(
			stock.stopReason,
			"stop",
			stock.errorMessage ?? "unexpected stop reason",
		);
		const { stream: _stream, ...stockBody } = JSON.parse(
			JSON.stringify(stockPayload),
		);
		const { type: _type, ...directBody } = direct.body;
		assert.equal(stockBody.max_output_tokens, 4095);
		assert.deepEqual(directBody, stockBody);
		const additional = { ...options, textVerbosity: "medium" };
		const verbose = await provider
			.streamSimple(model, normalizeContext(context), additional)
			.result();
		assert.equal(
			verbose.stopReason,
			"stop",
			verbose.errorMessage ?? "unexpected stop reason",
		);
		const verboseBody = (await fixture.records()).requests.at(-1)?.body;
		assert.deepEqual(verboseBody?.["text"], { verbosity: "medium" });
		assert.equal(
			verboseBody?.["max_output_tokens"],
			stockBody.max_output_tokens,
		);
	} finally {
		await provider.close();
		await fixture.close();
	}
});

test("direct WebSocket request matches stock subscription preparation and retains validated continuation without Codex auth", {
	timeout: 30_000,
}, async () => {
	const fixture = await protocolFixture();
	const stockModel = openaiProvider()
		.getModels()
		.find(({ id }) => id === "gpt-6-luna");
	assert.ok(stockModel);
	const model: Model<"openai-responses"> = {
		...stockModel,
		baseUrl: `${fixture.baseUrl}/v1`,
	};
	const provider = createOpenAIResponsesProvider({
		mode: "direct",
		models: [model],
	});
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("openai", async () => ({
		type: "oauth",
		access: "opaque-direct-token",
		refresh: "unused",
		clientId: "issued-client",
		expires: Date.now() + 3_600_000,
	}));
	const models = createModels({ credentials });
	models.setProvider(provider);
	const request = {
		apiKey: "opaque-direct-token",
		sessionId: "direct-session",
		reasoning: "high" as const,
		temperature: 0.2,
		maxTokens: 123,
		cacheRetention: "long" as const,
	};
	const context = {
		messages: [
			{
				role: "system" as const,
				content: "Keep the original system prompt",
				timestamp: 0,
			},
			user("one"),
		],
	};
	try {
		const first = await models.completeSimple(model, context, request);
		assert.equal(
			first.stopReason,
			"stop",
			first.errorMessage ?? "unexpected stop reason",
		);
		assert.equal(first.api, "openai-responses");
		const initial = (await fixture.records()).requests[0];
		assert.ok(initial);
		assert.equal(initial.path, "/v1/responses");
		assert.equal(
			initial.headers["authorization"],
			"Bearer opaque-direct-token",
		);
		for (const name of [
			"chatgpt-account-id",
			"originator",
			"thread-id",
			"session-id",
			"openai-beta",
		])
			assert.equal(initial.headers[name], undefined);
		for (const name of [
			"stream",
			"background",
			"client_metadata",
			"instructions",
			"max_output_tokens",
			"temperature",
			"prompt_cache_options",
			"prompt_cache_retention",
		])
			assert.equal(initial.body[name], undefined);
		let stockPayload: unknown;
		const stock = await stockStream(stockModel, normalizeContext(context), {
			...request,
			reasoningEffort: "high",
			onPayload: (body) => {
				stockPayload = body;
			},
			fetch: (_url, init) => fetch(`${fixture.baseUrl}/v1/responses`, init),
		}).result();
		assert.equal(
			stock.stopReason,
			"stop",
			stock.errorMessage ?? "unexpected stop reason",
		);
		const { stream: _stream, ...stockBody } = JSON.parse(
			JSON.stringify(stockPayload),
		);
		const { type: _type, ...directBody } = initial.body;
		assert.deepEqual(directBody, stockBody);
		const nextContext = { messages: [...context.messages, first, user("two")] };
		await provider.prewarm(model, nextContext, request);
		const second = await models.completeSimple(model, nextContext, request);
		assert.equal(
			second.stopReason,
			"stop",
			second.errorMessage ?? "unexpected stop reason",
		);
		const delta = (await fixture.records()).requests.at(-1);
		assert.equal(delta?.socket, initial.socket);
		assert.equal(delta?.body.input.length, 1);
		assert.ok(delta?.body.previous_response_id);
		const replaced = await models.completeSimple(
			model,
			{ messages: [user("changed")] },
			request,
		);
		assert.equal(
			replaced.stopReason,
			"stop",
			replaced.errorMessage ?? "unexpected stop reason",
		);
		assert.equal(
			(await fixture.records()).requests.at(-1)?.body.previous_response_id,
			undefined,
		);
		const toolContext = {
			tools: [
				{
					name: "calculate",
					description: "Double a number",
					parameters: Type.Object({ n: Type.String() }),
					constrainedSampling: {
						type: "grammar" as const,
						variants: { openai_lark: "start: /[0-9]+/" },
					},
				},
			],
			messages: [user("call-tool")],
		};
		const called = await models.completeSimple(model, toolContext, {
			...request,
			sessionId: "direct-tool",
		});
		assert.equal(
			called.stopReason,
			"toolUse",
			called.errorMessage ?? "unexpected stop reason",
		);
		const call = called.content.find((block) => block.type === "toolCall");
		assert.ok(call);
		assert.deepEqual(call.arguments, { n: "21" });
		const receipt = {
			role: "toolResult" as const,
			toolCallId: call.id,
			toolName: call.name,
			content: [{ type: "text" as const, text: "42" }],
			isError: false,
			timestamp: 2,
		};
		const answered = await models.completeSimple(
			model,
			{ ...toolContext, messages: [...toolContext.messages, called, receipt] },
			{ ...request, sessionId: "direct-tool" },
		);
		assert.equal(
			answered.stopReason,
			"stop",
			answered.errorMessage ?? "unexpected stop reason",
		);
		assert.equal(
			(await fixture.records()).requests.at(-1)?.body.input[0]?.["type"],
			"custom_tool_call_output",
		);
		const liteOptions = { ...request, responsesLite: true };
		const forbidden = await provider
			.streamSimple(model, normalizeContext(context), liteOptions)
			.result();
		assert.equal(forbidden.stopReason, "error");
		assert.match(
			forbidden.errorMessage ?? "",
			/does not support Responses Lite/,
		);
		await provider.resetSession(request.sessionId);
		const reset = await models.completeSimple(model, context, request);
		assert.equal(
			reset.stopReason,
			"stop",
			reset.errorMessage ?? "unexpected stop reason",
		);
		assert.notEqual(
			(await fixture.records()).requests.at(-1)?.socket,
			initial.socket,
		);
		const rejected = await models.completeSimple(model, context, {
			...request,
			transport: "sse",
		});
		assert.equal(rejected.stopReason, "error");
		assert.match(rejected.errorMessage ?? "", /without SSE fallback/);
		const before = (await fixture.records()).requests.length;
		await fixture.mode("reject-upgrade");
		const failed = await models.completeSimple(model, context, {
			...request,
			sessionId: "rejected",
			maxRetries: 0,
		});
		assert.equal(failed.stopReason, "error");
		assert.ok(
			(await fixture.records()).requests
				.slice(before)
				.every(({ transport }) => transport === "upgrade"),
		);
	} finally {
		await provider.close();
		await fixture.close();
	}
});
