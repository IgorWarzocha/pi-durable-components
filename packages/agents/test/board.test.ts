import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
	TaskId,
} from "@earendil-works/pi-durable";
import {
	createRegistry,
	defineExtension,
	Harness,
	hook,
	LiveDoc,
	ToolTask,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BoardNotices } from "../src/board/notices.ts";
import { BoardIndex, MutationReceipt } from "../src/board/store-model.ts";
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
				if (!signal?.aborted) await Promise.race([released, stopped]);
			} finally {
				signal?.removeEventListener("abort", cancel);
			}
		},
	};
}

type Controls = {
	hold?: ReturnType<typeof gate>;
	failHeld?: boolean;
	seenNotices?: Set<string>;
	interrupt?: {
		callId: string;
		gate: ReturnType<typeof gate>;
		task?: TaskId;
		value?: JsonObject;
	};
};

async function fixture(path: string, controls: Controls = {}) {
	const models = createModels();
	const faux = fauxProvider();
	models.setProvider(faux.provider);
	const route: FauxResponseStep = async (request, options) => {
		for (const message of request.messages) {
			if (message.role !== "user") continue;
			for (const line of textOf([message]).split("\n")) {
				if (line.startsWith("Board post ")) controls.seenNotices?.add(line);
			}
		}
		const last = request.messages.findLast((item) => item.role !== "system");
		if (last?.role === "toolResult") return fauxAssistantMessage("done");
		const input = textOf(last === undefined ? [] : [last]);
		if (input === "hold board recipient") {
			await controls.hold?.wait(options?.signal);
			if (controls.failHeld)
				return fauxAssistantMessage("recipient failed", {
					stopReason: "error",
					errorMessage: "Held provider failed",
				});
			return fauxAssistantMessage("recipient done");
		}
		if (!input.startsWith("{")) return fauxAssistantMessage("done");
		const command = object(JSON.parse(input));
		return fauxAssistantMessage(
			fauxToolCall(string(command["tool"]), object(command["args"]), {
				id: string(command["callId"]),
			}),
			{ stopReason: "toolUse" },
		);
	};
	faux.setResponses(Array.from({ length: 500 }, () => route));
	const component = createAgents({
		profiles: {
			general: {
				description: "Board worker",
				agent: { instructions: "Worker" },
			},
		},
	});
	const interruption = defineExtension({
		name: "test.board-interruption",
		hooks: [
			hook(ToolTask, {
				async afterTool(call, result, api, ctx) {
					const stop = controls.interrupt;
					if (stop?.callId !== call.id) return;
					stop.task = api.taskId;
					stop.value = object(result.details);
					await stop.gate.wait(ctx.abortSignal);
				},
			}),
		],
	});
	const registry = createRegistry();
	registry.install(component.extension);
	registry.install(interruption);
	const failures: unknown[] = [];
	const storage = await openNodeSqliteStorage(path);
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
	const agent = {
		model: { provider: "faux", modelId: "faux-1" },
		cwd: "/virtual/board",
		extensions: [component.extension, interruption],
	};
	const root = await harness.root(context, { agent });
	return { harness, root, failures, agent };
}

function object(value: unknown): JsonObject {
	assert.ok(isJsonValue(value));
	assert.ok(
		value !== null && typeof value === "object" && !Array.isArray(value),
	);
	return value;
}
function string(value: unknown): string {
	assert.ok(typeof value === "string");
	return value;
}
function rows(value: JsonObject): JsonObject[] {
	assert.ok(Array.isArray(value["results"]));
	return value["results"].map(object);
}
function submit(
	conversation: Conversation,
	tool: string,
	args: JsonObject,
	callId = randomUUID(),
) {
	return conversation.submit(
		{
			type: "input",
			content: JSON.stringify({ tool, args, callId }),
		},
		context,
	);
}
async function result(conversation: Conversation, callId: string) {
	const messages = (
		await conversation.entries({}, 100, undefined, context)
	).items.flatMap((entry) => entry.model ?? []);
	const message = messages.find(
		(item) => item.role === "toolResult" && item.toolCallId === callId,
	);
	assert.ok(message?.role === "toolResult", `Missing result ${callId}`);
	return message;
}
async function invoke(
	conversation: Conversation,
	tool: string,
	args: JsonObject,
) {
	const callId = randomUUID();
	assert.equal(
		(await (await submit(conversation, tool, args, callId)).wait(context))
			.status,
		"done",
	);
	return result(conversation, callId);
}
async function board(conversation: Conversation, args: JsonObject) {
	const answer = await invoke(conversation, "board", args);
	assert.equal(answer.isError, false, textOf([answer]));
	const value = object(answer.details);
	assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 8000);
	assert.ok(Buffer.byteLength(textOf([answer])) <= 8000);
	assert.deepEqual(JSON.parse(textOf([answer])), value);
	return value;
}
async function pending(harness: Harness, conversation: Conversation) {
	return Object.values(
		(await harness.snapshot(BoardNotices, conversation.id, context))?.pending ??
			{},
	);
}
async function spawn(
	f: Awaited<ReturnType<typeof fixture>>,
	parent: Conversation,
	label: string,
) {
	const answer = await invoke(parent, "agents", {
		action: "spawn",
		agent_type: "general",
		label,
		message: "ready",
	});
	assert.equal(answer.isError, false, textOf([answer]));
	const value = object(answer.details);
	const fleet = await f.harness.snapshot(Fleet, context);
	const delegation = Object.values(fleet?.delegations ?? {}).find(
		(item) => String(item.target) === value["target"],
	);
	assert.ok(delegation);
	await f.harness.waitForTask(delegation.reporter, context);
	const child = await f.harness.conversation(delegation.target, context);
	assert.ok(child);
	return { child, path: string(value["boardAgent"]) };
}

test("board trees retain read-only archives, Unicode text and bounded continuations across membership changes", {
	timeout: 25_000,
}, async () => {
	const directory = await mkdtemp(join(tmpdir(), "durable-board-reads-"));
	const f = await fixture(join(directory, "session.sqlite"));
	try {
		const identity = await board(f.root, { action: "help" });
		const id = string(identity["board_id"]);
		assert.equal(identity["agent_name"], "/root");
		assert.equal(
			rows(await board(f.root, { action: "list_boards" })).length,
			0,
		);
		const worker = await spawn(f, f.root, "Board reader");
		const grandchild = await spawn(f, worker.child, "Nested reader");
		await grandchild.child.configure({ cwd: "/virtual/grandchild" }, context);
		assert.ok(grandchild.path.startsWith(`${worker.path}/`));
		assert.equal(
			(await board(grandchild.child, { action: "help" }))["board_id"],
			id,
		);
		await board(grandchild.child, {
			action: "create_channel",
			channel_name: "Straße",
			subscribe: false,
		});
		assert.equal(
			rows(
				await board(worker.child, { action: "get_channels", query: "STRASSE" }),
			)[0]?.["channel_name"],
			"Straße",
		);
		const body = `Straße 😀\n"\\${'😀\n"\\ß'.repeat(3000)}`;
		const first = await board(f.root, {
			action: "post",
			channel_name: "Straße",
			text: body,
		});
		const postId = string(first["message_id"]);
		assert.equal(first["thread_id"], postId);
		const hits = rows(
			await board(worker.child, {
				action: "search_posts",
				query: "STRASSE",
				author: "/root",
			}),
		);
		assert.deepEqual(
			hits.map((item) => item["message_id"]),
			[postId],
		);
		let offset = 0;
		let restored = "";
		do {
			const page = await board(worker.child, {
				action: "read_post",
				message_id: postId,
				offset_chars: offset,
			});
			const text = string(page["text"]);
			assert.equal(
				text,
				Array.from(body)
					.slice(offset, Number(page["next_offset_chars"]))
					.join(""),
			);
			assert.ok(Number(page["next_offset_chars"]) > offset);
			offset = Number(page["next_offset_chars"]);
			restored += text;
			assert.equal(page["n_chars"], Array.from(body).length);
		} while (offset < Array.from(body).length);
		assert.equal(restored, body);
		const replyIds: string[] = [];
		for (let i = 0; i < 3; i++)
			replyIds.push(
				string(
					(
						await board(i === 1 ? grandchild.child : worker.child, {
							action: "post",
							thread_id: postId,
							text: `${i} ${body}`,
						})
					)["message_id"],
				),
			);
		assert.deepEqual(
			rows(
				await board(worker.child, {
					action: "search_posts",
					author: grandchild.path.slice(worker.path.length + 1),
				}),
			).map((row) => row["message_id"]),
			[replyIds[1]],
		);
		let cursor: string | undefined;
		const seen: string[] = [];
		do {
			const page = await board(f.root, {
				action: "read_thread",
				thread_id: postId,
				limit: 2,
				max_chars_per_post: 20000,
				...(cursor === undefined ? {} : { cursor }),
			});
			assert.equal(object(page["root_post"])["message_id"], postId);
			seen.push(...rows(page).map((row) => string(row["message_id"])));
			cursor =
				page["has_more"] === true ? string(page["next_cursor"]) : undefined;
		} while (cursor !== undefined);
		assert.deepEqual(seen, replyIds.toReversed());
		const threads = rows(
			await board(f.root, {
				action: "list_threads",
				channel_name: "Straße",
				sort: "activity",
			}),
		);
		assert.equal(threads[0]?.["reply_count"], 3);
		const outsider = await f.harness.createConversation(
			{ ownership: { kind: "ownerless" }, agent: f.agent },
			context,
		);
		const old = string((await board(outsider, { action: "help" }))["board_id"]);
		assert.notEqual(old, id);
		await board(outsider, {
			action: "post",
			new_channel_name: "Private",
			text: "old archive",
		});
		const attached = await invoke(f.root, "agents", {
			action: "attach",
			target: String(outsider.id),
		});
		assert.equal(attached.isError, false, textOf([attached]));
		assert.equal((await board(outsider, { action: "help" }))["board_id"], id);
		assert.equal(
			rows(
				await board(outsider, { action: "get_channels", board_id: old }),
			)[0]?.["channel_name"],
			"Private",
		);
		assert.equal(
			(
				await invoke(outsider, "board", {
					action: "post",
					board_id: old,
					channel_name: "Private",
					text: "forbidden",
				})
			).isError,
			true,
		);
		assert.equal(
			(
				await invoke(outsider, "board", {
					action: "subscribe",
					target_agent: "/root/missing",
					channel_name: "Straße",
				})
			).isError,
			true,
		);
		const detached = await invoke(f.root, "agents", {
			action: "detach",
			target: String(outsider.id),
		});
		assert.equal(detached.isError, false, textOf([detached]));
		assert.equal((await board(outsider, { action: "help" }))["board_id"], old);
		assert.equal(
			rows(await board(outsider, { action: "get_channels" }))[0]?.[
				"channel_name"
			],
			"Private",
		);
		assert.equal(
			rows(
				await board(outsider, { action: "get_channels", board_id: id }),
			)[0]?.["channel_name"],
			"Straße",
		);
		const catalog = await board(outsider, { action: "list_boards", limit: 1 });
		assert.equal(catalog["has_more"], true);
		const remaining = await board(outsider, {
			action: "list_boards",
			limit: 1,
			cursor: string(catalog["next_cursor"]),
		});
		const archives = [...rows(catalog), ...rows(remaining)];
		assert.equal(
			archives.find((row) => row["board_id"] === id)?.["owner_folder"],
			"/virtual/board",
		);
		assert.deepEqual(
			archives.map((row) => row["board_id"]).sort(),
			[id, old].sort(),
		);
		assert.equal(
			archives.find((row) => row["board_id"] === old)?.["current"],
			true,
		);
		assert.equal(
			archives.find((row) => row["board_id"] === id)?.["current"],
			false,
		);
		assert.equal(remaining["has_more"], false);
		const isolated = await fixture(join(directory, "other-session.sqlite"));
		try {
			assert.equal(
				rows(
					await board(isolated.root, { action: "get_channels", board_id: id }),
				).length,
				0,
			);
			assert.equal(
				(
					await invoke(isolated.root, "board", {
						action: "read_post",
						board_id: id,
						message_id: postId,
					})
				).isError,
				true,
			);
			assert.equal(
				rows(await board(isolated.root, { action: "list_boards" })).length,
				0,
			);
			assert.deepEqual(isolated.failures, []);
		} finally {
			await isolated.harness.close(context);
		}
		assert.deepEqual(f.failures, []);
	} finally {
		await f.harness.close(context);
		await rm(directory, { recursive: true, force: true });
	}
});

test("board subscriptions steer only active inputs, never idle members, and notices cannot leak after abort or provider failure", {
	timeout: 20_000,
}, async () => {
	const directory = await mkdtemp(join(tmpdir(), "durable-board-notices-"));
	const path = join(directory, "session.sqlite");
	const controls: Controls = { hold: gate(), seenNotices: new Set() };
	let f = await fixture(path, controls);
	try {
		const busy = await spawn(f, f.root, "Active reader");
		const idle = await spawn(f, f.root, "Idle reader");
		await board(f.root, {
			action: "create_channel",
			channel_name: "Changes",
			subscribe: false,
		});
		for (const child of [busy.child, idle.child])
			await board(child, { action: "subscribe", channel_name: "Changes" });
		const thread = await board(f.root, {
			action: "post",
			channel_name: "Changes",
			text: "thread root",
		});
		const threadId = string(thread["thread_id"]);
		await board(busy.child, { action: "subscribe", thread_id: threadId });
		const idleBefore = (await idle.child.entries({}, 100, undefined, context))
			.items.length;
		const held = await busy.child.submit(
			{ type: "input", content: "hold board recipient" },
			context,
		);
		await controls.hold?.begun;
		await board(f.root, {
			action: "post",
			channel_name: "Changes",
			text: "channel first post",
			agents_to_notify: [
				busy.path,
				busy.path.slice("/root/".length),
				idle.path,
				"/root",
			],
		});
		await board(f.root, {
			action: "post",
			thread_id: threadId,
			text: "subscribed reply",
		});
		const other = await board(f.root, {
			action: "post",
			new_channel_name: "Other",
			text: "unsubscribed thread",
		});
		await board(f.root, {
			action: "post",
			thread_id: string(other["thread_id"]),
			text: "not delivered",
		});
		const queue = await pending(f.harness, busy.child);
		assert.equal(queue.length, 2);
		const anchor = (await f.harness.snapshot(LiveDoc, busy.child.id, context))
			?.run?.inputs[0];
		assert.ok(
			queue.every(
				(item) =>
					item.input === anchor && item.content.startsWith("Board post "),
			),
		);
		assert.equal((await pending(f.harness, idle.child)).length, 0);
		assert.equal(
			(await f.harness.snapshot(LiveDoc, idle.child.id, context))?.run,
			undefined,
		);
		assert.equal(
			(await idle.child.entries({}, 100, undefined, context)).items.length,
			idleBefore,
		);
		controls.hold?.release();
		assert.equal((await held.wait(context)).status, "done");
		await busy.child.waitForIdle(context);
		const delivered = (await busy.child.context(context)).messages.filter(
			(message) =>
				message.role === "user" && textOf([message]).startsWith("Board post "),
		);
		assert.equal(textOf(delivered).match(/Board post /g)?.length, 2);
		assert.match(textOf(delivered), /channel first post/);
		assert.match(textOf(delivered), /subscribed reply/);
		assert.equal(controls.seenNotices?.size, 2);
		assert.match(
			[...(controls.seenNotices ?? [])].join("\n"),
			/channel first post/,
		);
		assert.match(
			[...(controls.seenNotices ?? [])].join("\n"),
			/subscribed reply/,
		);
		await board(busy.child, { action: "unsubscribe", channel_name: "Changes" });
		controls.hold = gate();
		await busy.child.submit(
			{ type: "input", content: "hold board recipient" },
			context,
		);
		await controls.hold.begun;
		await board(f.root, {
			action: "post",
			channel_name: "Changes",
			text: "unsubscribed channel",
		});
		assert.equal((await pending(f.harness, busy.child)).length, 0);
		const aborted = await board(f.root, {
			action: "post",
			thread_id: threadId,
			text: "cancel this notice",
		});
		assert.equal((await pending(f.harness, busy.child)).length, 1);
		await busy.child.abort(context);
		assert.equal(
			(await f.harness.snapshot(LiveDoc, busy.child.id, context))?.run,
			undefined,
		);
		await f.harness.close(context);
		f = await fixture(path, controls);
		const resumed = await f.harness.conversation(busy.child.id, context);
		assert.ok(resumed);
		await board(resumed, { action: "help" });
		assert.equal(
			(await resumed.context(context)).messages.filter(
				(message) =>
					message.role === "user" &&
					textOf([message]).includes("cancel this notice"),
			).length,
			0,
		);
		assert.ok(
			[...(controls.seenNotices ?? [])].every(
				(notice) => !notice.includes("cancel this notice"),
			),
		);
		assert.equal(
			(
				await board(resumed, {
					action: "read_post",
					message_id: string(aborted["message_id"]),
				})
			)["text"],
			"cancel this notice",
		);
		controls.hold = gate();
		controls.failHeld = true;
		const failedTurn = await resumed.submit(
			{ type: "input", content: "hold board recipient" },
			context,
		);
		await controls.hold.begun;
		const failedNotice = await board(f.root, {
			action: "post",
			thread_id: threadId,
			text: "notice for failed turn",
		});
		controls.hold.release();
		const failed = await failedTurn.wait(context);
		assert.equal(failed.status, "unanswered");
		if (failed.status === "unanswered") {
			assert.equal(failed.reason, "model_error");
			assert.equal(failed.detail, "Held provider failed");
		}
		controls.failHeld = false;
		await (
			await resumed.submit(
				{ type: "input", content: "next ordinary turn" },
				context,
			)
		).wait(context);
		assert.equal(
			(await resumed.context(context)).messages.filter(
				(message) =>
					message.role === "user" &&
					textOf([message]).includes("notice for failed turn"),
			).length,
			0,
		);
		assert.ok(
			[...(controls.seenNotices ?? [])].every(
				(notice) => !notice.includes("notice for failed turn"),
			),
		);
		assert.equal(
			(
				await board(resumed, {
					action: "read_post",
					message_id: string(failedNotice["message_id"]),
				})
			)["text"],
			"notice for failed turn",
		);
		assert.deepEqual(f.failures, []);
	} finally {
		controls.hold?.release();
		await f.harness.close(context);
		await rm(directory, { recursive: true, force: true });
	}
});

test("every board mutation returns its original task receipt after interruption without duplicating posts or reversing newer subscriptions", {
	timeout: 25_000,
}, async () => {
	const directory = await mkdtemp(join(tmpdir(), "durable-board-receipts-"));
	const path = join(directory, "session.sqlite");
	const controls: Controls = { seenNotices: new Set() };
	let f = await fixture(path, controls);
	try {
		const identity = await board(f.root, { action: "help" });
		const boardId = string(identity["board_id"]);
		const worker = await spawn(f, f.root, "Receipt reader");
		const workerId = worker.child.id;
		for (const action of [
			"create_channel",
			"post",
			"subscribe",
			"unsubscribe",
		]) {
			const callId = randomUUID();
			const stop: NonNullable<Controls["interrupt"]> = { callId, gate: gate() };
			controls.interrupt = stop;
			if (action === "post") {
				const peer = await f.harness.conversation(workerId, context);
				assert.ok(peer);
				await board(peer, { action: "subscribe", channel_name: "Receipts" });
				controls.hold = gate();
				await peer.submit(
					{ type: "input", content: "hold board recipient" },
					context,
				);
				await controls.hold.begun;
			}
			const args: JsonObject = {
				action,
				channel_name: "Receipts",
				...(action === "post" ? { text: "publish exactly once" } : {}),
			};
			const submission = await submit(f.root, "board", args, callId);
			await stop.gate.begun;
			assert.ok(stop.task);
			assert.ok(stop.value);
			const receipt = await f.harness.snapshot(
				MutationReceipt,
				stop.task,
				context,
			);
			assert.deepEqual(receipt?.saved?.value, stop.value);
			const before = await f.harness.snapshot(BoardIndex, boardId, context);
			assert.ok(before);
			if (action === "subscribe" || action === "unsubscribe") {
				const peer = await f.harness.conversation(workerId, context);
				assert.ok(peer);
				await board(peer, {
					action: action === "subscribe" ? "unsubscribe" : "subscribe",
					channel_name: "Receipts",
					target_agent: "/root",
				});
			}
			const expected = await f.harness.snapshot(BoardIndex, boardId, context);
			const peer = await f.harness.conversation(workerId, context);
			assert.ok(peer);
			if (action === "post")
				assert.equal((await pending(f.harness, peer)).length, 1);
			await f.harness.close(context);
			const replay: NonNullable<Controls["interrupt"]> = {
				callId,
				gate: gate(),
			};
			controls.interrupt = replay;
			f = await fixture(path, controls);
			const resumed = await f.harness.submission(submission.id, context);
			assert.ok(resumed);
			const settled = resumed.wait(context);
			// Teardown closes this wait if an assertion fails while the hook is held.
			settled.catch(() => {});
			await replay.gate.begun;
			assert.equal(replay.task, stop.task);
			assert.deepEqual(replay.value, stop.value);
			assert.deepEqual(
				await f.harness.snapshot(BoardIndex, boardId, context),
				expected,
			);
			assert.deepEqual(
				(await f.harness.snapshot(MutationReceipt, stop.task, context))?.saved,
				receipt?.saved,
			);
			if (action === "post") {
				controls.hold?.release();
				const peer = await f.harness.conversation(workerId, context);
				assert.ok(peer);
				await peer.waitForIdle(context);
				assert.equal(
					(await peer.context(context)).messages.filter(
						(message) =>
							message.role === "user" &&
							textOf([message]).startsWith("Board post "),
					).length,
					1,
				);
				assert.equal((await pending(f.harness, peer)).length, 0);
				assert.equal(controls.seenNotices?.size, 1);
				assert.match(
					[...(controls.seenNotices ?? [])].join("\n"),
					/publish exactly once/,
				);
			}
			replay.gate.release();
			assert.equal((await settled).status, "done");
			const answer = await result(f.root, callId);
			assert.equal(answer.isError, false, textOf([answer]));
			assert.deepEqual(answer.details, stop.value);
			delete controls.interrupt;
			assert.deepEqual(f.failures, []);
		}
		const posts = rows(
			await board(f.root, {
				action: "search_posts",
				query: "publish exactly once",
			}),
		);
		assert.equal(posts.length, 1);
	} finally {
		controls.interrupt?.gate.release();
		controls.hold?.release();
		await f.harness.close(context);
		await rm(directory, { recursive: true, force: true });
	}
});
