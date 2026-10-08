import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type AssistantMessage,
	type Context,
	InMemoryCredentialStore,
	normalizeContext,
	type Provider,
	type Tool,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	createRegistry,
	defineTool,
	Harness,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Type } from "typebox";
import {
	type CodexDiagnosticsEvent,
	createOpenAIResponsesProvider,
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

test("SQLite Durable tool round reaches real SSE and records cache usage without re-executing effects", {
	timeout: 30_000,
}, async () => {
	const fixture = await protocolFixture();
	const directory = await mkdtemp(join(tmpdir(), "durable-responses-"));
	const model = localModel(fixture.baseUrl);
	const provider = createOpenAIResponsesProvider({
		id: model.provider,
		models: [model],
		transport: "sse",
	});
	const models = await registeredModels(provider);
	let effects = 0;
	const tool = defineTool({
		name: "calculate",
		description: "Double a number",
		parameters: Type.Object({ n: Type.Number() }),
		replay: "unsafe",
		async execute({ n }) {
			effects++;
			return { content: [{ type: "text", text: String(n * 2) }] };
		},
	});
	const extension = { name: "local-calculation", tools: [tool] };
	const registry = createRegistry();
	registry.install(extension);
	const context = BACKGROUND_CONTEXT;
	const reports: unknown[] = [];
	const harness = await Harness.open(
		await openNodeSqliteStorage(join(directory, "session.sqlite")),
		{
			models,
			registry,
			settings: { retry: { enabled: false }, compaction: { enabled: false } },
			onReport: (error) => reports.push(error),
		},
		context,
	);
	try {
		const root = await harness.root(context, {
			agent: {
				model: { provider: provider.id, modelId: model.id },
				extensions: [extension],
			},
		});
		const submission = await root.submit(
			{ type: "input", content: "call-tool" },
			context,
		);
		const settled = await submission.wait(context);
		assert.equal(settled.status, "done", JSON.stringify(settled));
		assert.equal(effects, 1);
		assert.deepEqual(reports, []);
		const timed = (await root.context(context)).messages.filter(
			(message) =>
				message.role === "assistant" || message.role === "toolResult",
		);
		assert.equal(timed.length, 3);
		for (const message of timed) {
			assert.equal(typeof message.durationMs, "number");
			assert.ok(Number.isFinite(message.durationMs));
			assert.ok((message.durationMs ?? -1) >= 0);
		}
		const { requests } = await fixture.records();
		assert.equal(requests.length, 2);
		assert.ok(
			requests.every(
				(request) =>
					request.transport === "sse" && request.path === "/codex/responses",
			),
		);
		assert.equal(requests[0]?.headers["chatgpt-account-id"], "local-account");
		assert.equal(requests[0]?.headers["authorization"], `Bearer ${apiKey}`);
		assert.equal(
			requests[0]?.headers["session-id"],
			requests[1]?.headers["session-id"],
		);
		const output = requests[1]?.body.input.find(
			(item) => item["type"] === "function_call_output",
		);
		assert.ok(output);
		assert.equal(output["call_id"], "call_1");
		assert.match(JSON.stringify(output["output"]), /42/);
		const usage = (await harness.usage(context)).models[
			`${provider.id}/${model.id}`
		];
		assert.ok(usage);
		assert.equal(usage.input, 20);
		assert.equal(usage.cacheRead, 14);
		assert.equal(usage.cacheWrite, 6);
		assert.equal(usage.output, 8);
		assert.equal(usage.totalTokens, 48);
		assert.ok(usage.cost.total > 0);
	} finally {
		await harness.close(context);
		await provider.close();
		await fixture.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("Models Lite grammar replay preserves custom calls after the active tool declaration changes", {
	timeout: 30_000,
}, async () => {
	const fixture = await protocolFixture();
	const model = localModel(fixture.baseUrl, "gpt-5.6-luna");
	const provider = createOpenAIResponsesProvider({
		id: model.provider,
		models: [model],
		transport: "sse",
	});
	const models = await registeredModels(provider);
	try {
		const input = user("call-tool");
		const result = await models.completeSimple(
			model,
			{
				systemPrompt: "Be precise",
				tools: [grammar],
				messages: [input],
			},
			{ apiKey, sessionId: "lite" },
		);
		assert.equal(
			result.stopReason,
			"toolUse",
			result.errorMessage ?? "unexpected stop reason",
		);
		const call = result.content.find((block) => block.type === "toolCall");
		assert.ok(call);
		assert.deepEqual(call.arguments, { n: "21" });
		assert.equal(call.namespace, "functions");
		const history: Context = {
			messages: [
				input,
				result,
				{
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					content: [{ type: "text", text: "42" }],
					isError: false,
					timestamp: 2,
				},
			],
			tools: [
				{
					...grammar,
					constrainedSampling: false,
					parameters: Type.Object({ replacement: Type.String() }),
				},
			],
		};
		const replay = await models.complete(model, history, {
			apiKey,
			sessionId: "lite",
		});
		assert.equal(
			replay.stopReason,
			"stop",
			replay.errorMessage ?? "unexpected stop reason",
		);
		const { requests } = await fixture.records();
		const first = requests[0];
		const second = requests[1];
		assert.ok(first && second);
		assert.equal(
			first.headers["x-openai-internal-codex-responses-lite"],
			"true",
		);
		assert.equal(first.body.instructions, undefined);
		assert.equal(first.body.tools, undefined);
		assert.equal(first.body.input[0]?.["type"], "additional_tools");
		assert.match(
			JSON.stringify(first.body.input[0]),
			/"name":"functions".*"type":"custom"/,
		);
		assert.equal(
			second.headers["x-openai-internal-codex-responses-lite"],
			undefined,
			"auto requires a current grammar tool",
		);
		assert.deepEqual(
			second.body.input.find((item) => item["type"] === "custom_tool_call"),
			{
				type: "custom_tool_call",
				id: "ctc_1",
				call_id: "call_1",
				name: "calculate",
				namespace: "functions",
				input: "21",
			},
		);
		const output = second.body.input.find(
			(item) => item["type"] === "custom_tool_call_output",
		);
		assert.ok(output);
		assert.equal(output["call_id"], "call_1");
		assert.match(JSON.stringify(output["output"]), /42/);
		assert.equal(
			second.body.input.some((item) => item["type"] === "function_call"),
			false,
		);
		const unsupported = localModel(fixture.baseUrl);
		const ordinary = await models.completeSimple(
			unsupported,
			{ messages: [user("no-call")], tools: [grammar] },
			{ apiKey },
		);
		assert.equal(
			ordinary.stopReason,
			"stop",
			ordinary.errorMessage ?? "unexpected stop reason",
		);
		assert.equal(
			(await fixture.records()).requests[2]?.headers[
				"x-openai-internal-codex-responses-lite"
			],
			undefined,
			"auto also requires a supported model",
		);
		const oldInput = user("call-tool original function");
		const oldFunction = await models.completeSimple(
			model,
			{
				messages: [oldInput],
				tools: [
					{
						...grammar,
						constrainedSampling: false,
						parameters: Type.Object({ n: Type.Number() }),
					},
				],
			},
			{ apiKey, sessionId: "function-to-grammar" },
		);
		assert.equal(
			oldFunction.stopReason,
			"toolUse",
			oldFunction.errorMessage ?? "unexpected stop reason",
		);
		const oldCall = oldFunction.content.find(
			(block) => block.type === "toolCall",
		);
		assert.ok(oldCall);
		assert.deepEqual(oldCall.arguments, { n: 21 });
		const activated = await models.completeSimple(
			model,
			{
				tools: [grammar],
				messages: [
					oldInput,
					oldFunction,
					{
						role: "toolResult",
						toolCallId: oldCall.id,
						toolName: oldCall.name,
						content: [{ type: "text", text: "42" }],
						isError: false,
						timestamp: 2,
					},
				],
			},
			{ apiKey, sessionId: "function-to-grammar" },
		);
		assert.equal(
			activated.stopReason,
			"stop",
			activated.errorMessage ??
				"historical JSON must not be coerced to grammar input",
		);
		const activatedRequest = (await fixture.records()).requests.at(-1);
		assert.ok(activatedRequest);
		assert.equal(
			activatedRequest.headers["x-openai-internal-codex-responses-lite"],
			"true",
		);
		assert.deepEqual(
			activatedRequest.body.input.find(
				(item) => item["type"] === "function_call",
			),
			{
				type: "function_call",
				id: "fc_1",
				call_id: "call_1",
				name: "calculate",
				arguments: '{"n":21}',
			},
		);
		const oldReceipt = activatedRequest.body.input.find(
			(item) => item["type"] === "function_call_output",
		);
		assert.ok(oldReceipt);
		assert.equal(oldReceipt["call_id"], "call_1");
		assert.match(JSON.stringify(oldReceipt["output"]), /42/);
		assert.equal(
			activatedRequest.body.input.some(
				(item) =>
					item["type"] === "custom_tool_call" ||
					item["type"] === "custom_tool_call_output",
			),
			false,
		);
	} finally {
		await provider.close();
		await fixture.close();
	}
});

test("cached WebSocket exact-prefix delta, full-prefix replacement, session reset and prewarm cross a real socket", {
	timeout: 30_000,
}, async () => {
	const fixture = await protocolFixture();
	const model = localModel(fixture.baseUrl, "gpt-5.6-luna");
	const diagnostics: CodexDiagnosticsEvent[] = [];
	const provider = createOpenAIResponsesProvider({
		id: model.provider,
		models: [model],
		diagnostics: (event) => diagnostics.push(event),
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
		assert.ok(
			diagnostics.some(
				(event) => event.type === "request" && event.continuation === "delta",
			),
		);
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
		const warm = await provider.prewarm(model, firstContext, {
			apiKey,
			sessionId: "warm",
		});
		assert.equal(warm?.socketReused, false);
		const prepared = {
			model: model.id,
			store: false,
			stream: true,
			input: [{ role: "user", content: "prepared" }],
			text: { verbosity: "medium" },
			include: [],
			tool_choice: "auto" as const,
			parallel_tool_calls: true,
		};
		await provider.prewarmPrepared(model, prepared, {
			apiKey,
			sessionId: "prepared",
		});
		requests = (await fixture.records()).requests;
		assert.equal(requests[4]?.body["generate"], false);
		assert.equal(requests[5]?.body["generate"], false);
		assert.deepEqual(requests[5]?.body.input, prepared.input);
		await provider.resetSession("cached");
		const afterWarm = await models.completeSimple(model, firstContext, {
			apiKey,
			sessionId: "warm",
		});
		assert.equal(
			afterWarm.stopReason,
			"stop",
			afterWarm.errorMessage ?? "unexpected stop reason",
		);
		requests = (await fixture.records()).requests;
		assert.equal(requests[6]?.socket, requests[4]?.socket);
		assert.notEqual(requests[6]?.socket, requests[3]?.socket);
		const pendingTools = [
			{
				...grammar,
				constrainedSampling: false as const,
				parameters: Type.Object({ n: Type.Number() }),
			},
		];
		const pending = await models.completeSimple(
			model,
			{
				tools: pendingTools,
				messages: [user("call-tool original prefix")],
			},
			{ apiKey, sessionId: "pending-prefix" },
		);
		assert.equal(
			pending.stopReason,
			"toolUse",
			pending.errorMessage ?? "unexpected stop reason",
		);
		const pendingCall = pending.content.find(
			(block) => block.type === "toolCall",
		);
		assert.ok(pendingCall);
		const changedPending = await models.completeSimple(
			model,
			{
				tools: pendingTools,
				messages: [
					user("call-tool REWRITTEN prefix"),
					pending,
					{
						role: "toolResult",
						toolCallId: pendingCall.id,
						toolName: pendingCall.name,
						content: [{ type: "text", text: "42" }],
						isError: false,
						timestamp: 2,
					},
				],
			},
			{ apiKey, sessionId: "pending-prefix" },
		);
		assert.equal(
			changedPending.stopReason,
			"stop",
			changedPending.errorMessage ?? "unexpected stop reason",
		);
		requests = (await fixture.records()).requests;
		const fullPending = requests.at(-1);
		assert.ok(fullPending);
		assert.equal(
			fullPending.body.previous_response_id,
			undefined,
			"a pending call ID is not proof that an earlier user prefix still matches",
		);
		assert.match(JSON.stringify(fullPending.body.input), /REWRITTEN prefix/);
		assert.equal(
			fullPending.body.input.some(
				(item) =>
					item["type"] === "function_call_output" &&
					item["call_id"] === "call_1",
			),
			true,
		);
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

test("sticky fallback and fatal errors stay isolated while abort, reset and close settle held requests without replay", {
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
		await fixture.mode("reject-upgrade");
		assert.equal((await run()).stopReason, "stop");
		await fixture.mode("normal");
		assert.equal((await run()).stopReason, "stop");
		assert.equal(
			(await isolated.streamSimple(model, context, options).result())
				.stopReason,
			"stop",
		);
		let records = await fixture.records();
		assert.deepEqual(
			records.requests.map((request) => request.transport),
			["upgrade", "sse", "sse", "websocket"],
		);
		await fixture.mode("fatal");
		const fatal = await isolated
			.stream(model, context, { ...options, toolChoice: "required" })
			.result();
		assert.equal(fatal.stopReason, "error");
		assert.match(fatal.errorMessage ?? "", /context_length_exceeded/);
		assert.equal(
			(await fixture.records()).requests[4]?.body["tool_choice"],
			"required",
		);
		assert.equal(
			(await fixture.records()).requests.length,
			5,
			"fatal API errors must not retry or fall back",
		);
		await fixture.mode("normal");
		await provider.resetSession(options.sessionId);
		assert.equal((await run()).stopReason, "stop");
		assert.equal(
			(await fixture.records()).requests[5]?.transport,
			"websocket",
			"reset clears sticky SSE",
		);
		await isolated.prewarm(model, { messages: [user("one")] }, options);
		const isolatedSocket = (await fixture.records()).requests[6]?.socket;
		assert.equal(typeof isolatedSocket, "number");
		await fixture.mode("hold");
		const controller = new AbortController();
		const pending = provider
			.streamSimple(model, context, { ...options, signal: controller.signal })
			.result();
		await fixture.waitFor(8);
		controller.abort();
		assert.equal((await pending).stopReason, "aborted");
		assert.equal(
			(await fixture.records()).requests.length,
			8,
			"cancelled generation is not replayed",
		);
		const resetting = run();
		await fixture.waitFor(9);
		await provider.resetSession(options.sessionId);
		assert.equal((await resetting).stopReason, "aborted");
		const closing = run();
		await fixture.waitFor(10);
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
		records = await fixture.records();
		assert.equal(
			records.requests.length,
			11,
			"reset and close must not replay or admit work after close",
		);
		assert.equal(records.requests[10]?.transport, "websocket");
		assert.equal(
			records.requests[10]?.socket,
			isolatedSocket,
			"another instance's reset and close preserve this cached socket",
		);
		await fixture.waitForClosed(
			records.requests
				.slice(7, 10)
				.flatMap((request) =>
					request.socket === undefined ? [] : [request.socket],
				),
		);
		const preflight = createOpenAIResponsesProvider({
			id: model.provider,
			models: [model],
		});
		try {
			const missingKey = await preflight
				.streamSimple(model, context, { sessionId: "preflight" })
				.result();
			assert.equal(missingKey.stopReason, "error");
			const callbackFailure = await preflight
				.streamSimple(model, context, {
					...options,
					onPayload() {
						throw new Error("payload callback rejected");
					},
				})
				.result();
			assert.equal(callbackFailure.stopReason, "error");
			assert.match(
				callbackFailure.errorMessage ?? "",
				/payload callback rejected/,
			);
			assert.equal(
				(await fixture.records()).requests.length,
				11,
				"preflight failures never reach the wire",
			);
			for (const transport of ["sse", "websocket"] as const) {
				const requestCount = (await fixture.records()).requests.length;
				let observerEffects = 0;
				const observerOptions = {
					...options,
					transport,
					maxRetries: 1,
					onOutputItemDone() {
						observerEffects++;
						if (observerEffects === 1)
							throw new Error(
								"checkpoint side effect completed before failure",
							);
					},
				};
				const observerFailure = await preflight
					.stream(model, context, observerOptions)
					.result();
				assert.equal(
					observerFailure.stopReason,
					"error",
					"host observer failures cannot become a successful transport retry",
				);
				assert.match(
					observerFailure.errorMessage ?? "",
					/checkpoint side effect completed before failure/,
				);
				assert.equal(
					observerEffects,
					1,
					"do not replay a host side effect after its outcome is uncertain",
				);
				assert.equal(
					(await fixture.records()).requests.length,
					requestCount + 1,
					"host observer failure must not regenerate a completed response",
				);
			}
			assert.equal(
				(await preflight.streamSimple(model, context, options).result())
					.stopReason,
				"stop",
			);
			assert.equal(
				(await fixture.records()).requests.at(-1)?.transport,
				"websocket",
				"observer failures must not make SSE fallback sticky",
			);
		} finally {
			await preflight.close();
		}
	} finally {
		await provider.close();
		await isolated.close();
		await fixture.close();
	}
});
