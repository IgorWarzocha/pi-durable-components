import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { isJsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import type { FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type {
	Conversation,
	JsonObject,
	Storage,
	TaskId,
} from "@earendil-works/pi-durable";
import {
	createRegistry,
	Harness,
	MemoryStorage,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createAgents } from "../src/index.ts";
import { Fleet, textOf } from "../src/state.ts";

const context = BACKGROUND_CONTEXT;

function gate() {
	let started!: () => void;
	let release!: () => void;
	const begun = new Promise<void>((resolve) => {
		started = resolve;
	});
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	return {
		begun,
		release,
		async wait(signal?: AbortSignal) {
			started();
			let cancel!: () => void;
			const stopped = new Promise<void>((resolve) => {
				cancel = resolve;
			});
			signal?.addEventListener("abort", cancel, { once: true });
			try {
				if (signal?.aborted) return;
				await Promise.race([released, stopped]);
			} finally {
				signal?.removeEventListener("abort", cancel);
			}
		},
	};
}

async function fixture(storage: Storage = new MemoryStorage(), hold = gate()) {
	const models = createModels();
	const faux = fauxProvider();
	models.setProvider(faux.provider);
	let call = 0;
	const route: FauxResponseStep = async (request, options) => {
		const last = request.messages.findLast((item) => item.role !== "system");
		const text = textOf(last === undefined ? [] : [last]);
		const input = textOf(
			request.messages.filter((item) => item.role === "user").slice(-1),
		);
		if (last?.role === "toolResult")
			return fauxAssistantMessage(
				input.includes("tool round")
					? "FINAL worker answer"
					: "controller done",
			);
		if (text.startsWith("[Agent result]"))
			return fauxAssistantMessage("report received");
		if (text.startsWith("[Task from") || text.startsWith("[Message from")) {
			if (text.includes("hold")) await hold.wait(options?.signal);
			if (text.includes("tool round"))
				return fauxAssistantMessage(
					[
						{ type: "text", text: "INTERMEDIATE tool message" },
						fauxToolCall(
							"agents",
							{ action: "help" },
							{ id: `help-${++call}` },
						),
					],
					{ stopReason: "toolUse" },
				);
			return fauxAssistantMessage(`worker answer: ${text}`);
		}
		const args: unknown = JSON.parse(text);
		return fauxAssistantMessage(
			fauxToolCall("agents", jsonObject(args), { id: `call-${++call}` }),
			{ stopReason: "toolUse" },
		);
	};
	faux.setResponses(Array.from({ length: 200 }, () => route));
	const component = createAgents({
		profiles: {
			general: {
				description: "General worker",
				agent: { instructions: "worker instructions" },
			},
			async: {
				description: "Always asynchronous",
				blocking: false,
				agent: { instructions: "worker instructions" },
			},
		},
	});
	const registry = createRegistry();
	registry.install(component.extension);
	const reports: string[] = [];
	const failures: unknown[] = [];
	const harness = await Harness.open(
		storage,
		{
			models,
			registry,
			settings: { retry: { enabled: false } },
			onReport: (error) => failures.push(error),
		},
		context,
	);
	component.bind(harness, storage);
	harness.subscribeCommits((publication) => {
		for (const change of publication.changes) {
			if (
				change.type === "submission" &&
				change.value.requestId?.startsWith("agents:report:")
			) {
				if (!reports.includes(change.value.requestId))
					reports.push(change.value.requestId);
			}
		}
	});
	const root = await harness.root(context, {
		agent: {
			model: { provider: "faux", modelId: "faux-1" },
			extensions: [component.extension],
		},
	});
	return { harness, root, reports, failures, hold };
}

async function invoke(root: Conversation, args: JsonObject) {
	await (
		await root.submit({ type: "input", content: JSON.stringify(args) }, context)
	).wait(context);
	const entries = await root.entries({}, 100, undefined, context);
	const message = entries.items
		.flatMap((entry) => entry.model ?? [])
		.find((item) => item.role === "toolResult");
	assert.ok(message?.role === "toolResult");
	return message;
}

function jsonObject(value: unknown): JsonObject {
	assert.ok(isJsonValue(value));
	assert.ok(
		typeof value === "object" && value !== null && !Array.isArray(value),
	);
	return value;
}

async function latestDelegation(harness: Harness) {
	const fleet = await harness.snapshot(Fleet, context);
	const result = Object.values(fleet?.delegations ?? {}).at(-1);
	assert.ok(result);
	return result;
}

async function reportEntries(root: Conversation) {
	return (await root.entries({}, 100, undefined, context)).items.filter(
		(entry) =>
			entry.model?.some(
				(item) =>
					item.role === "user" && textOf([item]).startsWith("[Agent result]"),
			),
	);
}

function watchDelivery(harness: Harness, id: TaskId) {
	return new Promise<string>((resolve) => {
		const unsubscribe = harness.subscribeCommits((publication) => {
			for (const change of publication.changes) {
				if (
					change.type === "submission" &&
					change.value.requestId?.startsWith("agents:report:")
				) {
					unsubscribe();
					resolve("reported");
				}
				if (
					change.type === "task" &&
					change.value.id === id &&
					change.value.state.status === "terminal"
				) {
					unsubscribe();
					resolve(change.value.state.outcome.status);
				}
			}
		});
	});
}

test("a reopened watch reports only the settled input answer, not an intermediate tool-use message", {
	timeout: 15_000,
}, async () => {
	const directory = await mkdtemp(
		join(tmpdir(), "durable-agents-watch-settlement-"),
	);
	const path = join(directory, "session.sqlite");
	const hold = gate();
	let f = await fixture(await openNodeSqliteStorage(path), hold);
	try {
		await invoke(f.root, {
			action: "spawn",
			agent_type: "general",
			label: "Continuing worker",
			message: "first",
		});
		const receipt = await latestDelegation(f.harness);
		await f.harness.waitForTask(receipt.reporter, context);
		// Only the explicit watch reports this message. No delegation reporter can mask a broken watcher.
		await invoke(f.root, {
			action: "send",
			target: receipt.name,
			message: "hold tool round",
		});
		await f.hold.begun;
		await invoke(f.root, { action: "watch", target: receipt.name });
		const id = (await f.harness.snapshot(Fleet, context))?.watches[
			`${f.root.id}:${receipt.target}`
		];
		assert.ok(id);
		await setImmediate();
		await f.harness.close(context);
		f = await fixture(await openNodeSqliteStorage(path), hold);
		const delivered = watchDelivery(f.harness, id);
		f.hold.release();
		const child = await f.harness.conversation(receipt.target, context);
		assert.ok(child);
		await child.waitForIdle(context);
		assert.equal(await delivered, "reported");
		await f.root.waitForIdle(context);
		// Stop and join the watcher, including any already-durable report phase, before counting reports.
		await invoke(f.root, { action: "unwatch", target: receipt.name });
		const watch = await f.harness.waitForTask(id, context);
		await f.root.waitForIdle(context);
		const reports = await reportEntries(f.root);
		assert.equal(reports.length, 1);
		assert.match(textOf(reports[0]?.model), /FINAL worker answer/);
		assert.doesNotMatch(textOf(reports[0]?.model), /INTERMEDIATE tool message/);
		assert.equal(watch.state.outcome.status, "completed");
		assert.deepEqual(f.failures, []);
	} finally {
		await f.harness.close(context);
		await rm(directory, { recursive: true, force: true });
	}
});

test("ordinary controller abort detaches blocking work and reports its eventual answer", {
	timeout: 10_000,
}, async () => {
	const f = await fixture();
	try {
		const submission = await f.root.submit(
			{
				type: "input",
				content: JSON.stringify({
					action: "spawn",
					agent_type: "general",
					label: "Detached worker",
					message: "hold",
				}),
			},
			context,
		);
		await f.hold.begun;
		const receipt = await latestDelegation(f.harness);
		await f.root.abort(context);
		assert.equal((await submission.wait(context)).status, "unanswered");
		assert.notEqual(
			(await f.harness.getTask(receipt.dispatch, context))?.state.status,
			"terminal",
		);
		f.hold.release();
		await f.harness.waitForTask(receipt.reporter, context);
		await f.root.waitForIdle(context);
		assert.equal((await reportEntries(f.root)).length, 1);
		assert.deepEqual(f.failures, []);
	} finally {
		await f.harness.close(context);
	}
});

test("reopen resumes the blocking tool and child without duplicate children, task input or completion delivery", {
	timeout: 15_000,
}, async () => {
	const directory = await mkdtemp(join(tmpdir(), "durable-agents-"));
	const path = join(directory, "session.sqlite");
	const hold = gate();
	let f = await fixture(await openNodeSqliteStorage(path), hold);
	try {
		const submission = await f.root.submit(
			{
				type: "input",
				content: JSON.stringify({
					action: "spawn",
					agent_type: "general",
					label: "Recovery worker",
					message: "hold",
				}),
			},
			context,
		);
		await hold.begun;
		const before = await latestDelegation(f.harness);
		await f.harness.close(context);
		f = await fixture(await openNodeSqliteStorage(path), hold);
		const resumed = await f.harness.submission(submission.id, context);
		assert.ok(resumed);
		hold.release();
		assert.equal((await resumed.wait(context)).status, "done");
		const after = await latestDelegation(f.harness);
		assert.deepEqual(after, before);
		await f.harness.waitForTask(after.reporter, context);
		const fleet = await f.harness.snapshot(Fleet, context);
		assert.equal(Object.keys(fleet?.agents ?? {}).length, 1);
		assert.equal(Object.keys(fleet?.delegations ?? {}).length, 1);
		const child = await f.harness.conversation(after.target, context);
		assert.ok(child);
		const taskInputs = (
			await child.entries({}, 100, undefined, context)
		).items.filter((entry) =>
			entry.model?.some(
				(item) =>
					item.role === "user" && textOf([item]).startsWith("[Task from"),
			),
		);
		assert.equal(taskInputs.length, 1);
		assert.equal((await reportEntries(f.root)).length, 0);
		assert.deepEqual(f.failures, []);
	} finally {
		await f.harness.close(context);
		await rm(directory, { recursive: true, force: true });
	}
});

test("explicit watches survive reopen, dedupe delegation reports, and unwatch stops an in-flight watch", {
	timeout: 15_000,
}, async () => {
	const directory = await mkdtemp(join(tmpdir(), "durable-agents-watch-"));
	const path = join(directory, "session.sqlite");
	let f = await fixture(await openNodeSqliteStorage(path));
	try {
		await invoke(f.root, {
			action: "spawn",
			agent_type: "general",
			label: "Watched worker",
			message: "first",
		});
		const initial = await latestDelegation(f.harness);
		await f.harness.waitForTask(initial.reporter, context);
		await invoke(f.root, { action: "watch", target: initial.name });
		const fleet = await f.harness.snapshot(Fleet, context);
		const watchId = fleet?.watches[`${f.root.id}:${initial.target}`];
		assert.ok(watchId);
		await f.harness.close(context);
		f = await fixture(await openNodeSqliteStorage(path));
		await invoke(f.root, {
			action: "assign",
			target: initial.name,
			message: "second",
			blocking: false,
		});
		const second = await latestDelegation(f.harness);
		await f.harness.waitForTask(second.reporter, context);
		await f.root.waitForIdle(context);
		assert.equal((await reportEntries(f.root)).length, 1);
		// The watch may still be delivering the same report. One stable request ID merges both routes.
		await invoke(f.root, {
			action: "send",
			target: initial.name,
			message: "hold",
		});
		await f.hold.begun;
		await invoke(f.root, { action: "unwatch", target: initial.name });
		await f.harness.waitForTask(watchId, context);
		assert.deepEqual((await f.harness.snapshot(Fleet, context))?.watches, {});
		f.hold.release();
		await (await f.harness.conversation(initial.target, context))?.waitForIdle(
			context,
		);
		await f.root.waitForIdle(context);
		assert.equal((await reportEntries(f.root)).length, 1);
		assert.deepEqual(f.failures, []);
	} finally {
		await f.harness.close(context);
		await rm(directory, { recursive: true, force: true });
	}
});

test("an asynchronous submission and its report survive independent controller turns and repeated reopen", {
	timeout: 15_000,
}, async () => {
	const directory = await mkdtemp(join(tmpdir(), "durable-agents-async-"));
	const path = join(directory, "session.sqlite");
	const hold = gate();
	let f = await fixture(await openNodeSqliteStorage(path), hold);
	try {
		await invoke(f.root, {
			action: "spawn",
			agent_type: "async",
			label: "Async recovery",
			message: "hold",
		});
		await hold.begun;
		const receipt = await latestDelegation(f.harness);
		await f.harness.close(context);
		f = await fixture(await openNodeSqliteStorage(path), hold);
		hold.release();
		await f.harness.waitForTask(receipt.reporter, context);
		await f.root.waitForIdle(context);
		const result = await f.harness.waitForTask(receipt.dispatch, context);
		assert.equal(result.state.outcome.status, "completed");
		assert.equal((await reportEntries(f.root)).length, 1);
		assert.equal(f.reports.length, 1);
		const admitted = await f.harness.commit(
			(tx) => tx.submissionByRequest(f.root.id, f.reports[0] ?? ""),
			context,
		);
		assert.equal(admitted?.status, "done");
		await f.harness.close(context);
		f = await fixture(await openNodeSqliteStorage(path), hold);
		await f.harness.waitForTask(receipt.reporter, context);
		await f.root.waitForIdle(context);
		assert.equal((await reportEntries(f.root)).length, 1);
		assert.deepEqual(f.reports, []);
		assert.equal(
			Object.keys((await f.harness.snapshot(Fleet, context))?.delegations ?? {})
				.length,
			1,
		);
		assert.deepEqual(f.failures, []);
	} finally {
		await f.harness.close(context);
		await rm(directory, { recursive: true, force: true });
	}
});

test("background-inclusive abort owns workers, reporters and watches", {
	timeout: 10_000,
}, async () => {
	const f = await fixture();
	try {
		await invoke(f.root, {
			action: "spawn",
			agent_type: "async",
			label: "Owned worker",
			message: "hold",
		});
		await f.hold.begun;
		const receipt = await latestDelegation(f.harness);
		await invoke(f.root, { action: "watch", target: receipt.name });
		const watchId = (await f.harness.snapshot(Fleet, context))?.watches[
			`${f.root.id}:${receipt.target}`
		];
		assert.ok(watchId);
		await f.root.abort(context, { background: true });
		for (const id of [receipt.dispatch, receipt.reporter, watchId]) {
			assert.equal(
				(await f.harness.getTask(id, context))?.state.status,
				"terminal",
			);
		}
		assert.deepEqual((await f.harness.snapshot(Fleet, context))?.watches, {});
		assert.deepEqual(f.failures, []);
	} finally {
		await f.harness.close(context);
	}
});
