import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { isJsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import type { FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type {
	Conversation,
	JsonObject,
	Storage,
	TaskId,
} from "@earendil-works/pi-durable";
import {
	AgentDoc,
	createRegistry,
	defineExtension,
	defineTool,
	GenerationTask,
	Harness,
	hook,
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
		if (text === "continue yield")
			return fauxAssistantMessage("FINAL worker answer");
		if (text.startsWith("[Agent result]"))
			return fauxAssistantMessage("report received");
		if (text.startsWith("[Task from") || text.startsWith("[Message from")) {
			if (text.includes("hold")) await hold.wait(options?.signal);
			if (text.includes("tool round"))
				return fauxAssistantMessage(
					[
						fauxText("I will check help first"),
						fauxToolCall(
							"agents",
							{ action: "help" },
							{ id: `help-${++call}` },
						),
					],
					{ stopReason: "toolUse" },
				);
			if (text.includes("yield continuation"))
				return fauxAssistantMessage("INTERMEDIATE yield");
			if (text.includes("terminate") || text.includes("handoff"))
				return fauxAssistantMessage(
					[
						fauxText("FINAL worker answer"),
						fauxToolCall(
							"finish",
							{ handoff: text.includes("handoff") },
							{ id: `finish-${++call}` },
						),
					],
					{ stopReason: "toolUse" },
				);
			if (text.includes("fail task"))
				return fauxAssistantMessage("worker error detail", {
					stopReason: "error",
					errorMessage: "Worker rejected task",
				});
			return fauxAssistantMessage(
				text.includes("large") ? "x".repeat(70_010) : `worker answer: ${text}`,
			);
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
				agent: { instructions: "worker instructions", cwd: "/virtual/profile" },
			},
			async: {
				description: "Always asynchronous",
				blocking: false,
				agent: { instructions: "worker instructions" },
			},
		},
	});
	const continuations = defineExtension({
		name: "test.continuations",
		hooks: [
			hook(GenerationTask, {
				onYield: (answer) =>
					textOf([answer]) === "INTERMEDIATE yield"
						? { continue: "continue yield" }
						: undefined,
			}),
		],
		tools: [
			defineTool({
				name: "finish",
				description: "End this run",
				parameters: Type.Object({ handoff: Type.Boolean() }),
				execute: async (args) => ({
					content: [{ type: "text", text: "finished" }],
					control: args.handoff
						? { handoff: "Next context" }
						: { terminate: true },
				}),
			}),
		],
	});
	const registry = createRegistry();
	registry.install(component.extension);
	registry.install(continuations);
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
			extensions: [component.extension, continuations],
		},
	});
	return { harness, root, reports, failures, hold, component };
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

function details(value: Awaited<ReturnType<typeof invoke>>): JsonObject {
	return jsonObject(value.details);
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

test("an idle persistent watch reconciles document wakeups without faulting or dropping send results", {
	timeout: 10_000,
}, async () => {
	for (const source of ["component", "host"])
		for (const unrelatedWake of [false, true]) {
			const f = await fixture();
			try {
				const target = await (async () => {
					if (source === "component") {
						await invoke(f.root, {
							action: "spawn",
							agent_type: "general",
							label: "Idle watcher",
							message: "first",
						});
						const receipt = await latestDelegation(f.harness);
						await f.harness.waitForTask(receipt.reporter, context);
						return receipt.target;
					}
					const peer = await f.harness.createConversation(
						{
							ownership: { kind: "ownerless" },
							agent: {
								model: { provider: "faux", modelId: "faux-1" },
								extensions: [f.component.extension],
							},
						},
						context,
					);
					// No request ID and no component registry entry. Watches must still follow native inputs.
					await (
						await peer.submit(
							{ type: "input", content: "[Message from host]\nfirst" },
							context,
						)
					).wait(context);
					return peer.id;
				})();
				await invoke(f.root, { action: "watch", target: String(target) });
				const id = (await f.harness.snapshot(Fleet, context))?.watches[
					`${f.root.id}:${target}`
				];
				assert.ok(id);
				const delivered = watchDelivery(f.harness, id);
				// Flush pending microtasks so this exercises the idle document wait, not startup reconciliation.
				await setImmediate();
				if (unrelatedWake) {
					await f.harness.commit(async (tx) => {
						(await tx.doc(Fleet)).changes["unrelated"] = {
							target,
							watched: false,
						};
					}, context);
					await setImmediate();
				}
				await invoke(f.root, {
					action: "send",
					target: String(target),
					message: "next",
				});
				assert.equal(await delivered, "reported");
				await f.root.waitForIdle(context);
				assert.equal((await reportEntries(f.root)).length, 1);
				assert.notEqual(
					(await f.harness.getTask(id, context))?.state.status,
					"terminal",
				);
				await invoke(f.root, { action: "unwatch", target: String(target) });
				assert.equal(
					(await f.harness.waitForTask(id, context)).state.outcome.status,
					"completed",
				);
				assert.deepEqual(f.failures, []);
			} finally {
				await f.harness.close(context);
			}
		}
});

test("watch completion follows input settlement across tools and onYield but preserves terminate and handoff answers", {
	timeout: 15_000,
}, async () => {
	for (const task of [
		"tool round",
		"yield continuation",
		"terminate",
		"handoff",
		"fail task",
	]) {
		const directory =
			task === "tool round"
				? await mkdtemp(join(tmpdir(), "durable-agents-continuation-"))
				: undefined;
		const path =
			directory === undefined ? undefined : join(directory, "session.sqlite");
		const hold = gate();
		let f = await fixture(
			path === undefined
				? new MemoryStorage()
				: await openNodeSqliteStorage(path),
			hold,
		);
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
				message: `hold ${task}`,
			});
			await f.hold.begun;
			await invoke(f.root, { action: "watch", target: receipt.name });
			const id = (await f.harness.snapshot(Fleet, context))?.watches[
				`${f.root.id}:${receipt.target}`
			];
			assert.ok(id);
			await setImmediate();
			if (path !== undefined) {
				await f.harness.close(context);
				f = await fixture(await openNodeSqliteStorage(path), hold);
			}
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
			assert.equal(reports.length, 1, task);
			assert.match(
				textOf(reports[0]?.model),
				task === "fail task" ? /Worker rejected task/ : /FINAL worker answer/,
				task,
			);
			assert.doesNotMatch(
				textOf(reports[0]?.model),
				/I will check help first|INTERMEDIATE yield/,
				task,
			);
			assert.equal(watch.state.outcome.status, "completed");
			assert.deepEqual(f.failures, []);
		} finally {
			await f.harness.close(context);
			if (directory !== undefined)
				await rm(directory, { recursive: true, force: true });
		}
	}
});

test("blocking delegation returns the actual answer and profile config without asynchronous echoes", {
	timeout: 10_000,
}, async () => {
	const f = await fixture();
	try {
		const answer = details(
			await invoke(f.root, {
				action: "spawn",
				agent_type: "general",
				label: "Prime reader",
				message: "primes",
				cwd: "/virtual/call",
			}),
		);
		assert.equal(answer["status"], "done");
		assert.equal(
			answer["reply"],
			`worker answer: [Task from conversation ${f.root.id}]\nprimes`,
		);
		const receipt = await latestDelegation(f.harness);
		await f.harness.waitForTask(receipt.reporter, context);
		assert.equal(
			(await f.harness.snapshot(AgentDoc, receipt.target, context))?.cwd,
			"/virtual/call",
		);
		assert.equal(
			(await f.harness.snapshot(AgentDoc, receipt.target, context))
				?.instructions,
			"worker instructions",
		);
		assert.deepEqual(f.reports, []);
		const reassigned = details(
			await invoke(f.root, {
				action: "assign",
				target: String(answer["target"]),
				message: "more primes",
			}),
		);
		assert.equal(reassigned["target"], answer["target"]);
		assert.equal(reassigned["assigned"], true);
		assert.equal(
			Object.keys((await f.harness.snapshot(Fleet, context))?.agents ?? {})
				.length,
			1,
		);
		assert.deepEqual(f.failures, []);
	} finally {
		await f.harness.close(context);
	}
});

test("profile blocking policy wins and asynchronous completion is task-scoped after the controller replies", {
	timeout: 10_000,
}, async () => {
	const f = await fixture();
	try {
		const answer = details(
			await invoke(f.root, {
				action: "spawn",
				agent_type: "async",
				label: "Slow reader",
				message: "hold",
				blocking: true,
			}),
		);
		await f.hold.begun;
		assert.equal(answer["status"], "working");
		assert.deepEqual(f.reports, []);
		const receipt = await latestDelegation(f.harness);
		const steering = details(
			await invoke(f.root, {
				action: "send",
				target: receipt.name,
				message: "steer now",
			}),
		);
		assert.equal(steering["sent"], true);
		assert.equal(
			Object.keys((await f.harness.snapshot(Fleet, context))?.delegations ?? {})
				.length,
			1,
		);
		assert.deepEqual(f.reports, []);
		f.hold.release();
		await f.harness.waitForTask(receipt.reporter, context);
		await f.root.waitForIdle(context);
		assert.equal((await reportEntries(f.root)).length, 1);
		assert.equal(f.reports.length, 1);
		const sent = details(
			await invoke(f.root, {
				action: "send",
				target: receipt.name,
				message: "next message",
			}),
		);
		assert.equal(sent["sent"], true);
		const child = await f.harness.conversation(receipt.target, context);
		assert.ok(child);
		await child.waitForIdle(context);
		assert.equal(f.reports.length, 1);
		assert.deepEqual((await f.harness.snapshot(Fleet, context))?.watches, {});
		assert.deepEqual(f.failures, []);
	} finally {
		await f.harness.close(context);
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

test("worker failures retain their reason and detail in blocking results and asynchronous follow-ups", {
	timeout: 10_000,
}, async () => {
	const f = await fixture();
	try {
		const blocked = await invoke(f.root, {
			action: "spawn",
			agent_type: "general",
			label: "Failure worker",
			message: "fail task",
		});
		assert.equal(blocked.isError, true);
		const failure = details(blocked);
		assert.equal(failure["status"], "failed");
		assert.equal(failure["reason"], "model_error");
		assert.equal(failure["reply"], "Worker rejected task");
		await invoke(f.root, {
			action: "assign",
			target: String(failure["target"]),
			message: "fail task",
			blocking: false,
		});
		await f.harness.waitForTask(
			(await latestDelegation(f.harness)).reporter,
			context,
		);
		await f.root.waitForIdle(context);
		const reports = await reportEntries(f.root);
		assert.equal(reports.length, 1);
		assert.match(textOf(reports[0]?.model), /Worker rejected task/);
		assert.deepEqual(f.failures, []);
	} finally {
		await f.harness.close(context);
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

test("read is bounded with exact text continuation and entry pagination", {
	timeout: 10_000,
}, async () => {
	const f = await fixture();
	try {
		const toolResult = await invoke(f.root, {
			action: "spawn",
			agent_type: "general",
			label: "Large reader",
			message: "large",
		});
		const answer = details(toolResult);
		assert.equal(
			jsonObject(JSON.parse(textOf([toolResult])))["reply"],
			"x".repeat(70_010),
		);
		const child = await f.harness.conversation(
			(await latestDelegation(f.harness)).target,
			context,
		);
		assert.ok(child);
		await child.commit(async (tx) => {
			for (let index = 0; index < 42; index++) {
				await tx.appendEntry(child.id, {
					kind: "app.note",
					model: [
						{ role: "user", content: `Stored note ${index}`, timestamp: 0 },
					],
				});
			}
		}, context);
		const read = details(
			await invoke(f.root, {
				action: "read",
				target: String(answer["target"]),
			}),
		);
		const entries = read["entries"];
		assert.ok(Array.isArray(entries));
		const entry = entries[0];
		assert.ok(
			typeof entry === "object" && entry !== null && !Array.isArray(entry),
		);
		assert.equal(String(read["reply"]).length, 36_000);
		assert.equal(entry["truncated"], true);
		const rest = details(
			await invoke(f.root, {
				action: "read",
				target: String(answer["target"]),
				entry: Number(entry["id"]),
				offset: Number(entry["nextOffset"]),
			}),
		);
		assert.ok(Array.isArray(rest["entries"]));
		const restEntry = rest["entries"][0];
		assert.ok(
			typeof restEntry === "object" &&
				restEntry !== null &&
				!Array.isArray(restEntry),
		);
		assert.equal(
			String(read["reply"]) + String(rest["reply"]),
			"x".repeat(70_010),
		);
		const recent = details(
			await invoke(f.root, {
				action: "read",
				target: String(answer["target"]),
				source: "recent",
				limit: 1,
				before: Number(entry["id"]),
			}),
		);
		assert.ok(Array.isArray(recent["entries"]));
		assert.equal(recent["entries"].length, 1);
		const prior = recent["entries"][0];
		assert.ok(
			typeof prior === "object" && prior !== null && !Array.isArray(prior),
		);
		assert.ok(Number(prior["id"]) < Number(entry["id"]));
		assert.deepEqual(f.failures, []);
	} finally {
		await f.harness.close(context);
	}
});

test("validation rejects excluded actions, unknown profiles and send blocking before side effects", {
	timeout: 10_000,
}, async () => {
	const f = await fixture();
	try {
		for (const args of [
			{ action: "answer", target: "0" },
			{ action: "send", target: "0", message: "no", blocking: true },
			{
				action: "spawn",
				agent_type: "missing",
				label: "No worker",
				message: "no",
			},
			{
				action: "spawn",
				agent_type: "general",
				label: "Invalid",
				message: "no",
			},
			{
				action: "spawn",
				agent_type: "general",
				label: "No worker",
				message: "no",
				name: String(f.root.id),
			},
		]) {
			assert.equal((await invoke(f.root, args)).isError, true);
		}
		assert.equal(
			Object.keys((await f.harness.snapshot(Fleet, context))?.agents ?? {})
				.length,
			0,
		);
		assert.deepEqual(f.reports, []);
	} finally {
		await f.harness.close(context);
	}
});
