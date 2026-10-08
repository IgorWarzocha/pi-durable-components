import assert from "node:assert/strict";
import test from "node:test";
import {
	type AssistantMessage,
	InMemoryCredentialStore,
	normalizeContext,
	type Provider,
	type Tool,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { Type } from "typebox";
import {
	createOpenAIResponsesProvider,
	type OpenAICodexStreamOptions,
} from "../src/index.ts";
import { apiKey, localModel, protocolFixture } from "./protocol-fixture.ts";

const user = (content: string) => ({
	role: "user" as const,
	content,
	timestamp: 1,
});
const grammar: Tool = {
	name: "calculate",
	description: "Double a number",
	parameters: Type.Object({ n: Type.String() }),
	constrainedSampling: {
		type: "grammar",
		variants: { openai_lark: "start: /[0-9]+/" },
	},
};

test("completion observer failure never replays an uncertain side effect", {
	timeout: 30_000,
}, async () => {
	const fixture = await protocolFixture();
	const model = localModel(fixture.baseUrl);
	const provider = createOpenAIResponsesProvider({
		id: model.provider,
		models: [model],
	});
	try {
		for (const transport of ["sse", "websocket"] as const) {
			const requestCount = (await fixture.records()).requests.length;
			let effects = 0;
			const options = {
				apiKey,
				sessionId: transport,
				transport,
				maxRetries: 1,
				onOutputItemDone() {
					effects++;
					if (effects === 1)
						throw new Error("checkpoint side effect completed before failure");
				},
			} satisfies OpenAICodexStreamOptions;
			const result = await provider
				.stream(model, normalizeContext({ messages: [user("one")] }), options)
				.result();
			assert.equal(result.stopReason, "error");
			assert.match(
				result.errorMessage ?? "",
				/checkpoint side effect completed before failure/,
			);
			assert.equal(effects, 1, "uncertain observer effects must not repeat");
			assert.equal(
				(await fixture.records()).requests.length,
				requestCount + 1,
				"observer failure must not regenerate a completed response",
			);
		}
	} finally {
		await provider.close();
		await fixture.close();
	}
});

async function registeredModels(provider: Provider) {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify(provider.id, async () => ({
		type: "oauth",
		access: apiKey,
		refresh: "unused",
		expires: Date.now() + 3_600_000,
	}));
	const models = createModels({ credentials });
	models.setProvider(provider);
	return models;
}

test("cached WebSocket continuation requires matching history and identity", {
	timeout: 30_000,
}, async () => {
	const fixture = await protocolFixture();
	const model = localModel(fixture.baseUrl, "gpt-5.6-luna");
	const provider = createOpenAIResponsesProvider({
		id: model.provider,
		models: [model],
	});
	const models = await registeredModels(provider);
	const options = { apiKey, sessionId: "cached" };
	try {
		const firstContext = {
			systemPrompt: "stable",
			tools: [grammar],
			messages: [user("one")],
		};
		const first = await models.completeSimple(model, firstContext, options);
		assert.equal(
			first.stopReason,
			"stop",
			first.errorMessage ?? "unexpected stop reason",
		);
		const nextContext = {
			...firstContext,
			messages: [user("one"), first, user("two")],
		};
		const next = await models.completeSimple(model, nextContext, options);
		assert.equal(
			next.stopReason,
			"stop",
			next.errorMessage ?? "unexpected stop reason",
		);
		const initialRequests = (await fixture.records()).requests;
		const initial = initialRequests[0];
		const delta = initialRequests[1];
		assert.ok(initial?.output && delta?.output);
		assert.equal(initial.body.input[0]?.["type"], "additional_tools");
		// The host reconstructs only conversation history, not Lite's tool/prompt prefix.
		const reconstructed = [
			...initial.body.input.slice(2),
			...initial.output,
			...delta.body.input,
			...delta.output,
		];
		const canonical = provider.getCanonicalRequest(
			model,
			"cached",
			apiKey,
			reconstructed,
		);
		assert.equal(canonical.decision, "validated");
		assert.ok(canonical.body);
		assert.equal(canonical.body.previous_response_id, undefined);
		assert.deepEqual(canonical.body.input, [
			...initial.body.input,
			...initial.output,
			...delta.body.input,
			...delta.output,
		]);
		assert.deepEqual(
			provider.getCanonicalRequest(
				{ ...model, id: "gpt-5.4" },
				"cached",
				apiKey,
				reconstructed,
			),
			{ decision: "model_mismatch" },
		);
		const otherAccountKey = `header.${Buffer.from(
			JSON.stringify({
				"https://api.openai.com/auth": { chatgpt_account_id: "other-account" },
			}),
		).toString("base64url")}.signature`;
		assert.deepEqual(
			provider.getCanonicalRequest(
				model,
				"cached",
				otherAccountKey,
				reconstructed,
			),
			{ decision: "identity_mismatch" },
		);
		assert.deepEqual(
			provider.getCanonicalRequest(model, "cached", apiKey, [
				{ ...reconstructed[0], content: "changed-prefix" },
				...reconstructed.slice(1),
			]),
			{ decision: "request_prefix_mismatch" },
		);
		const changedContext = {
			...nextContext,
			messages: [user("rewritten-prefix"), first, user("two")],
		};
		const changed = await models.completeSimple(model, changedContext, options);
		assert.equal(
			changed.stopReason,
			"stop",
			changed.errorMessage ?? "unexpected stop reason",
		);
		let { requests } = await fixture.records();
		assert.equal(requests.length, 3);
		assert.equal(requests[1]?.socket, requests[0]?.socket);
		assert.equal(requests[1]?.body.previous_response_id, first.responseId);
		assert.equal(requests[1]?.body.input.length, 1);
		assert.match(JSON.stringify(requests[1]?.body.input), /two/);
		assert.equal(requests[2]?.body.previous_response_id, undefined);
		assert.equal(requests[2]?.body.instructions, undefined);
		assert.match(JSON.stringify(requests[2]?.body.input[1]), /stable/);
		assert.match(JSON.stringify(requests[2]?.body.input), /rewritten-prefix/);
		assert.ok((requests[2]?.body.input.length ?? 0) > 1);
		await provider.resetSession("cached");
		assert.deepEqual(
			provider.getCanonicalRequest(model, "cached", apiKey, reconstructed),
			{ decision: "no_state" },
		);
		const reset = await models.completeSimple(model, firstContext, options);
		assert.equal(
			reset.stopReason,
			"stop",
			reset.errorMessage ?? "unexpected stop reason",
		);
		requests = (await fixture.records()).requests;
		assert.notEqual(requests[3]?.socket, requests[0]?.socket);
		assert.equal(requests[3]?.body.previous_response_id, undefined);
		await provider.close();
		await fixture.waitForClosed(
			requests.flatMap((request) =>
				request.socket === undefined ? [] : [request.socket],
			),
		);
	} finally {
		await provider.close();
		await fixture.close();
	}
});

test("abort, reset and close release owned sockets without replay or affecting another provider", {
	timeout: 30_000,
}, async () => {
	const fixture = await protocolFixture();
	const model = localModel(fixture.baseUrl);
	const provider = createOpenAIResponsesProvider({
		id: model.provider,
		models: [model],
	});
	const isolated = createOpenAIResponsesProvider({
		id: model.provider,
		models: [model],
	});
	const context = normalizeContext({ messages: [user("one")] });
	const options = { apiKey, sessionId: "same-session" };
	const run = () => provider.streamSimple(model, context, options).result();
	try {
		assert.equal((await run()).stopReason, "stop");
		assert.equal(
			(await isolated.streamSimple(model, context, options).result())
				.stopReason,
			"stop",
		);
		const isolatedSocket = (await fixture.records()).requests[1]?.socket;
		assert.equal(typeof isolatedSocket, "number");
		await fixture.mode("hold");
		const controller = new AbortController();
		const pending = provider
			.streamSimple(model, context, { ...options, signal: controller.signal })
			.result();
		await fixture.waitFor(3);
		controller.abort();
		assert.equal((await pending).stopReason, "aborted");
		assert.equal(
			(await fixture.records()).requests.length,
			3,
			"cancelled generation is not replayed",
		);
		const resetting = run();
		await fixture.waitFor(4);
		await provider.resetSession(options.sessionId);
		assert.equal((await resetting).stopReason, "aborted");
		const closing = run();
		await fixture.waitFor(5);
		await provider.close();
		assert.equal((await closing).stopReason, "aborted");
		const closed: AssistantMessage = await run();
		assert.equal(closed.stopReason, "error");
		assert.match(closed.errorMessage ?? "", /closed/);
		await fixture.mode("normal");
		const survivor = await isolated
			.streamSimple(model, context, options)
			.result();
		assert.equal(
			survivor.stopReason,
			"stop",
			survivor.errorMessage ?? "unexpected stop reason",
		);
		const records = await fixture.records();
		assert.equal(
			records.requests.length,
			6,
			"reset and close must not replay or admit work after close",
		);
		assert.equal(records.requests[5]?.transport, "websocket");
		assert.equal(
			records.requests[5]?.socket,
			isolatedSocket,
			"another instance's reset and close preserve this cached socket",
		);
		await fixture.waitForClosed(
			records.requests
				.slice(2, 5)
				.flatMap((request) =>
					request.socket === undefined ? [] : [request.socket],
				),
		);
	} finally {
		await provider.close();
		await isolated.close();
		await fixture.close();
	}
});
