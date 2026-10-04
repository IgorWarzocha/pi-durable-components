import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { isJsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import type { FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { JsonObject, TaskId } from "@earendil-works/pi-durable";
import {
	createRegistry,
	defineExtension,
	Harness,
	hook,
	ToolTask,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createContextManagement, type InputResult } from "../src/index.ts";
import { Admission, IDLE_MS, ROLLOVER_TASK } from "../src/lifecycle.ts";

const context = BACKGROUND_CONTEXT;
const checkpoint =
	"Checkpoint this conversation before a clean context window.";

function textOf(message: Message | undefined): string {
	if (!message) return "";
	return typeof message.content === "string"
		? message.content
		: message.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n");
}

function gate() {
	let start!: () => void;
	let release!: () => void;
	const begun = new Promise<void>((resolve) => {
		start = resolve;
	});
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	return {
		begun,
		release,
		async wait(signal?: AbortSignal) {
			start();
			let cancel!: () => void;
			const aborted = new Promise<void>((resolve) => {
				cancel = resolve;
			});
			signal?.addEventListener("abort", cancel, { once: true });
			try {
				if (!signal?.aborted) await Promise.race([released, aborted]);
			} finally {
				signal?.removeEventListener("abort", cancel);
			}
		},
	};
}

function driver() {
	return {
		now: 1_000,
		call: 0,
		failCheckpoint: false,
		checkpointGate: undefined as ReturnType<typeof gate> | undefined,
		appendGate: undefined as ReturnType<typeof gate> | undefined,
		observed: [] as ToolResultMessage[],
		requests: [] as Message[][],
	};
}

// Only model decisions and interruption timing are scripted. Storage, tools and scheduling are real.
async function fixture(path: string, state: ReturnType<typeof driver>) {
	const storage = await openNodeSqliteStorage(path);
	const models = createModels();
	const faux = fauxProvider({
		models: [{ id: "context", input: ["text", "image"] }],
	});
	models.setProvider(faux.provider);
	const call = (name: string, args: JsonObject) =>
		fauxAssistantMessage(
			fauxToolCall(name, args, { id: `call-${++state.call}` }),
			{ stopReason: "toolUse" },
		);
	const route: FauxResponseStep = async (request, options) => {
		state.requests.push([...request.messages]);
		const input = textOf(
			request.messages.findLast((message) => message.role === "user"),
		);
		const last = request.messages.findLast(
			(message) => message.role !== "system",
		);
		if (last?.role === "toolResult") {
			state.observed.push(last);
			if (input === "mixed rollover")
				return fauxAssistantMessage("mixed round rejected");
			assert.equal(last.isError, false, textOf(last));
			if (input === "rollover via tool" && last.toolName === "notes")
				return call("new_context", {});
			return fauxAssistantMessage(
				input === "Continue from your saved notes."
					? "FINAL resumed answer"
					: "FINAL answer",
			);
		}
		if (input.startsWith(checkpoint)) {
			await state.checkpointGate?.wait(options?.signal);
			if (state.failCheckpoint)
				return fauxAssistantMessage("checkpoint rejected", {
					stopReason: "error",
					errorMessage: "checkpoint rejected",
				});
			return call("notes", {
				action: "append_to_file",
				path: "active.md",
				text: "CHECKPOINT\n",
			});
		}
		if (input === "Continue from your saved notes.") {
			assert.ok(
				request.messages.some(
					(message) =>
						message.role === "system" &&
						JSON.stringify(message.sections).includes("/notes/active.md"),
				),
			);
			return call("notes", { action: "read_file", path: "active.md" });
		}
		if (input === "rollover via tool")
			return call("notes", {
				action: "append_to_file",
				path: "active.md",
				text: "TOOL CHECKPOINT\n",
			});
		if (input === "stale rollover") return call("new_context", {});
		if (input === "mixed rollover")
			return fauxAssistantMessage(
				[
					fauxToolCall(
						"notes",
						{
							action: "append_to_file",
							path: "active.md",
							text: "MIXED CHECKPOINT\n",
						},
						{ id: `call-${++state.call}` },
					),
					fauxToolCall("new_context", {}, { id: `call-${++state.call}` }),
				],
				{ stopReason: "toolUse" },
			);
		if (input.startsWith("{")) {
			const command: { tool: string; args: JsonObject } = JSON.parse(input);
			return call(command.tool, command.args);
		}
		return fauxAssistantMessage(`FINAL answer: ${input}`);
	};
	faux.setResponses(Array.from({ length: 200 }, () => route));
	const component = createContextManagement({ models, now: () => state.now });
	const interruption = defineExtension({
		name: "test.context-interruption",
		hooks: [
			hook(ToolTask, {
				async afterTool(call, _result, _api, ctx) {
					if (call.name === "notes" && call.arguments["text"] === "APPEND\n")
						await state.appendGate?.wait(ctx.abortSignal);
				},
			}),
		],
	});
	const registry = createRegistry();
	registry.install(component.extension);
	registry.install(interruption);
	const failures: unknown[] = [];
	const harness = await Harness.open(
		storage,
		{
			models,
			registry,
			now: () => state.now,
			settings: { retry: { enabled: false } },
			onReport: (error) => failures.push(error),
		},
		context,
	);
	component.bind(harness, storage);
	const root = await harness.root(context, {
		agent: {
			model: { provider: "faux", modelId: "context" },
			extensions: [component.extension, interruption],
		},
	});
	harness.resume();
	return { harness, root, component, failures };
}

async function result<T>(
	f: Awaited<ReturnType<typeof fixture>>,
	id: TaskId<T>,
): Promise<T> {
	const task = await f.harness.waitForTask(id, context);
	assert.equal(
		task.state.outcome.status,
		"completed",
		JSON.stringify(task.state.outcome),
	);
	assert.ok(task.state.outcome.status === "completed");
	return task.state.outcome.result;
}

async function submit(
	f: Awaited<ReturnType<typeof fixture>>,
	content: string,
): Promise<InputResult> {
	return result(
		f,
		await f.component.submit(f.root.id, { type: "input", content }, context),
	);
}

async function invoke(
	f: Awaited<ReturnType<typeof fixture>>,
	state: ReturnType<typeof driver>,
	tool: string,
	args: JsonObject,
) {
	await submit(f, JSON.stringify({ tool, args }));
	const message = state.observed.at(-1);
	assert.ok(message);
	return object(message.details);
}

function object(value: unknown): JsonObject {
	assert.ok(isJsonValue(value));
	assert.ok(value && typeof value === "object" && !Array.isArray(value));
	return value;
}

async function blocked(f: Awaited<ReturnType<typeof fixture>>) {
	const watch = await f.harness.watchDoc(Admission, f.root.id, context);
	assert.ok(watch);
	try {
		await new Promise<void>((resolve) => {
			watch.start(async (value) => {
				if (value?.blocked) resolve();
			});
			if (watch.value?.blocked) resolve();
		});
	} finally {
		await watch.stop();
	}
}

test("SQLite context workflow replays notes once, retains history, checkpoints idle held attachments and follows tool rollover answers", {
	timeout: 20_000,
}, async () => {
	const directory = await mkdtemp(join(tmpdir(), "durable-context-"));
	const path = join(directory, "session.sqlite");
	const state = driver();
	let f = await fixture(path, state);
	try {
		await invoke(f, state, "notes", {
			action: "write_file",
			path: "active.md",
			text: "BASE\n",
		});
		state.appendGate = gate();
		const append = await f.component.submit(
			f.root.id,
			{
				type: "input",
				requestId: "append-once",
				content: JSON.stringify({
					tool: "notes",
					args: {
						action: "append_to_file",
						path: "active.md",
						text: "APPEND\n",
					},
				}),
			},
			context,
		);
		await state.appendGate.begun;
		await f.harness.close(context);
		state.appendGate.release();
		f = await fixture(path, state);
		assert.equal(
			await f.component.submit(
				f.root.id,
				{
					type: "input",
					requestId: "append-once",
					content: "must not replace original",
				},
				context,
			),
			append,
		);
		const appended = await result(f, append);
		assert.equal(appended.status, "done");
		assert.ok(appended.status === "done");
		const read = await invoke(f, state, "notes", {
			action: "read_file",
			path: "active.md",
			start_line: 1,
			stop_line: -1,
		});
		assert.equal(object(read["file"])["content"], "BASE\nAPPEND\n");
		const firstWindow = (await f.component.status(f.root.id, context)).window
			?.window;
		assert.ok(firstWindow);
		const manual = await result(
			f,
			await f.component.newContext(f.root.id, context),
		);
		assert.equal(manual.status, "done");
		assert.equal(
			(await f.component.status(f.root.id, context)).window?.window?.previous,
			firstWindow.id,
		);
		assert.ok(
			!state.requests.some((messages) =>
				messages.some(
					(message) =>
						message.role === "user" &&
						textOf(message) === "Continue from your saved notes.",
				),
			),
		);
		const view = await f.root.context(context);
		assert.ok(
			!view.messages.some((message) => textOf(message).includes("APPEND")),
		);
		const search = await invoke(f, state, "history", {
			action: "search_contents",
			query: "APPEND",
			role: "user",
			window_id: firstWindow.id,
			recent_first: true,
			limit: 1,
		});
		assert.ok(Array.isArray(search["items"]));
		const item = object(search["items"][0]);
		assert.equal(item["window_id"], firstWindow.id);
		assert.ok(typeof item["item_id"] === "string");
		const history = await invoke(f, state, "history", {
			action: "read_item",
			item_id: item["item_id"],
			window_id: firstWindow.id,
			offset_chars: 0,
			limit_chars: 8_000,
		});
		assert.match(String(object(history["item"])["content"]), /APPEND/);
		const budget = await invoke(f, state, "get_context_remaining", {});
		assert.equal(budget["known"], true);
		assert.equal(
			budget["windowId"],
			manual.status === "done" ? manual.window.id : undefined,
		);
		assert.equal(budget["contextWindow"], 128_000);
		assert.equal(budget["estimated"], true);
		assert.match(String(budget["uncertainty"]), /not an exact/);
		const idleWindow = (await f.component.status(f.root.id, context)).window
			?.window?.id;
		state.now += IDLE_MS - 1;
		await submit(f, "just before idle threshold");
		assert.equal(
			(await f.component.status(f.root.id, context)).window?.window?.id,
			idleWindow,
		);
		state.now += IDLE_MS;
		state.checkpointGate = gate();
		const attachment = [
			{ type: "text" as const, text: "held attachment" },
			{ type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" },
		];
		const held = await f.component.submit(
			f.root.id,
			{
				type: "input",
				requestId: "held-once",
				content: attachment,
				whenBusy: "reject",
			},
			context,
		);
		await state.checkpointGate.begun;
		assert.equal(
			(await f.component.status(f.root.id, context)).window?.window?.id,
			idleWindow,
		);
		assert.ok(
			!(await f.root.entries({}, 100, undefined, context)).items.some((entry) =>
				entry.model?.some((message) => textOf(message) === "held attachment"),
			),
		);
		await f.harness.close(context);
		f = await fixture(path, state);
		assert.equal(
			await f.component.submit(
				f.root.id,
				{ type: "input", requestId: "held-once", content: attachment },
				context,
			),
			held,
		);
		state.checkpointGate.release();
		const answer = await result(f, held);
		assert.equal(answer.status, "done");
		assert.ok(answer.status === "done");
		assert.equal(
			textOf(
				(await f.root.commit((tx) => tx.entry(answer.answer), context))
					?.model?.[0],
			),
			"FINAL answer: held attachment",
		);
		assert.equal(
			(await f.component.status(f.root.id, context)).window?.window?.previous,
			idleWindow,
		);
		const inputs = (await f.root.entries({}, 100, undefined, context)).items
			.flatMap((entry) => entry.model ?? [])
			.filter(
				(message) =>
					message.role === "user" && textOf(message) === "held attachment",
			);
		assert.equal(inputs.length, 1);
		assert.deepEqual(inputs[0]?.content, attachment);
		const heldRequest = state.requests.findLast((messages) =>
			messages.some((message) => textOf(message) === "held attachment"),
		);
		assert.ok(heldRequest);
		assert.ok(
			!heldRequest.some((message) => textOf(message).startsWith(checkpoint)),
		);
		const beforeMixed = (await f.component.status(f.root.id, context)).window
			?.window?.id;
		const rolloversBeforeMixed = await f.root.commit(
			(tx) =>
				tx.scanTasks({ conversationId: f.root.id, kind: ROLLOVER_TASK }, 64),
			context,
		);
		const requestsBeforeMixed = state.requests.length;
		assert.equal((await submit(f, "mixed rollover")).status, "done");
		const rejected = state.observed.at(-1);
		assert.equal(rejected?.toolName, "new_context");
		assert.equal(rejected?.isError, true);
		assert.match(textOf(rejected), /Call new_context alone/);
		const afterMixed = await f.component.status(f.root.id, context);
		assert.equal(afterMixed.window?.window?.id, beforeMixed);
		assert.equal(afterMixed.window?.transition, undefined);
		const rolloversAfterMixed = await f.root.commit(
			(tx) =>
				tx.scanTasks({ conversationId: f.root.id, kind: ROLLOVER_TASK }, 64),
			context,
		);
		assert.deepEqual(
			rolloversAfterMixed.items.map((task) => task.id),
			rolloversBeforeMixed.items.map((task) => task.id),
		);
		assert.ok(
			!state.requests
				.slice(requestsBeforeMixed)
				.some((messages) =>
					messages.some(
						(message) =>
							textOf(message).startsWith(checkpoint) ||
							textOf(message) === "Continue from your saved notes.",
					),
				),
		);
		const continued = await submit(f, "rollover via tool");
		assert.ok(continued.status === "done", JSON.stringify(continued));
		assert.equal(
			textOf(
				(await f.root.commit((tx) => tx.entry(continued.answer), context))
					?.model?.[0],
			),
			"FINAL resumed answer",
		);
		const persisted = await invoke(f, state, "notes", {
			action: "read_file",
			path: "active.md",
		});
		assert.equal(
			object(persisted["file"])["content"],
			"BASE\nAPPEND\nCHECKPOINT\nCHECKPOINT\nMIXED CHECKPOINT\nTOOL CHECKPOINT\n",
		);
		const retired = await invoke(f, state, "history", {
			action: "read_item",
			item_id: item["item_id"],
			window_id: firstWindow.id,
			offset_chars: 10,
			limit_chars: 15,
		});
		assert.equal(
			object(retired["item"])["content"],
			String(object(history["item"])["content"]).slice(10, 25),
		);
		assert.equal(object(retired["item"])["next_offset_chars"], 25);
		const fork = await f.root.fork(
			appended.answer,
			{ ownership: { kind: "ownerless" } },
			context,
		);
		const forked = { ...f, root: fork };
		const inherited = await invoke(forked, state, "history", {
			action: "read_item",
			item_id: item["item_id"],
			window_id: firstWindow.id,
		});
		assert.equal(
			object(inherited["item"])["content"],
			object(history["item"])["content"],
			"fork initialization must not invalidate inherited note references to history",
		);
		const forkNotes = await invoke(forked, state, "notes", {
			action: "read_file",
			path: "active.md",
		});
		assert.equal(object(forkNotes["file"])["content"], "BASE\nAPPEND\n");
		assert.deepEqual(f.failures, []);
	} finally {
		await f.harness.close(context);
		await rm(directory, { recursive: true, force: true });
	}
});

test("failed idle checkpoints hold queued input across reopen until explicit retry, and cancellation never releases held input", {
	timeout: 20_000,
}, async () => {
	const directory = await mkdtemp(join(tmpdir(), "durable-context-blocked-"));
	const path = join(directory, "session.sqlite");
	const state = driver();
	let f = await fixture(path, state);
	try {
		await submit(f, "original request");
		const original = (await f.component.status(f.root.id, context)).window
			?.window?.id;
		state.now += IDLE_MS;
		state.failCheckpoint = true;
		const held = await f.component.submit(
			f.root.id,
			{
				type: "input",
				requestId: "blocked-once",
				content: "held after failure",
			},
			context,
		);
		await blocked(f);
		assert.equal(
			(await f.component.status(f.root.id, context)).window?.window?.id,
			original,
		);
		assert.match(
			(await f.component.status(f.root.id, context)).admission?.blocked
				?.reason ?? "",
			/Checkpoint/,
		);
		await f.harness.close(context);
		f = await fixture(path, state);
		assert.equal(
			await f.component.submit(
				f.root.id,
				{
					type: "input",
					requestId: "blocked-once",
					content: "held after failure",
				},
				context,
			),
			held,
		);
		state.failCheckpoint = false;
		await setImmediate();
		assert.equal(
			(await f.component.status(f.root.id, context)).admission?.blocked?.task,
			held,
		);
		assert.ok(
			!state.requests.some((messages) =>
				messages.some((message) => textOf(message) === "held after failure"),
			),
		);
		await f.component.retry(f.root.id, context);
		assert.equal((await result(f, held)).status, "done");
		assert.equal((await submit(f, "next request after retry")).status, "done");
		assert.equal(
			(await f.component.status(f.root.id, context)).admission?.blocked,
			undefined,
		);
		// A tool rollover is linked through the input's durable continuation receipt, not its ownership tree.
		state.checkpointGate = gate();
		const beforeToolCancel = (await f.component.status(f.root.id, context))
			.window?.window?.id;
		const toolInput = await f.component.submit(
			f.root.id,
			{ type: "input", content: "stale rollover" },
			context,
		);
		await state.checkpointGate.begun;
		await f.harness.abortTask(toolInput, context);
		state.checkpointGate.release();
		assert.equal(
			(await f.harness.waitForTask(toolInput, context)).state.outcome.status,
			"aborted",
		);
		await f.root.waitForIdle(context);
		const afterToolCancel = await f.component.status(f.root.id, context);
		assert.equal(afterToolCancel.window?.window?.id, beforeToolCancel);
		assert.equal(afterToolCancel.window?.transition, undefined);
		assert.ok(
			!state.requests.some((messages) =>
				messages.some(
					(message) => textOf(message) === "Continue from your saved notes.",
				),
			),
		);
		state.checkpointGate = undefined;
		await submit(f, "idle cancellation anchor");
		state.now += IDLE_MS;
		state.checkpointGate = gate();
		const cancelled = await f.component.submit(
			f.root.id,
			{ type: "input", content: "must never be placed" },
			context,
		);
		await state.checkpointGate.begun;
		const secondCancelled = await f.component.submit(
			f.root.id,
			{ type: "input", content: "second held input" },
			context,
		);
		const beforeCancel = (await f.component.status(f.root.id, context)).window
			?.window?.id;
		await f.harness.abortTask(cancelled, context);
		assert.equal(
			(await f.harness.waitForTask(cancelled, context)).state.outcome.status,
			"aborted",
		);
		state.checkpointGate.release();
		assert.equal(
			(await f.harness.waitForTask(secondCancelled, context)).state.outcome
				.status,
			"aborted",
		);
		await f.root.waitForIdle(context);
		assert.equal(
			(await f.component.status(f.root.id, context)).window?.window?.id,
			beforeCancel,
		);
		assert.equal(
			(await f.component.status(f.root.id, context)).window?.transition,
			undefined,
		);
		assert.deepEqual(
			(await f.component.status(f.root.id, context)).admission?.queue,
			[],
		);
		assert.ok(
			!(await f.root.entries({}, 100, undefined, context)).items.some((entry) =>
				entry.model?.some((message) =>
					["must never be placed", "second held input"].includes(
						textOf(message),
					),
				),
			),
		);
		assert.ok(
			!state.requests.some((messages) =>
				messages.some((message) => textOf(message) === "second held input"),
			),
		);
		assert.deepEqual(f.failures, []);
	} finally {
		await f.harness.close(context);
		await rm(directory, { recursive: true, force: true });
	}
});
