import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createExecSessionManager } from "../src/shell/session-manager.ts";
import { createNodeShellBackend } from "../src/shell.ts";

const cwd = process.cwd();
const backend = () =>
	createNodeShellBackend({
		environmentId: "shell-test",
		defaultShell: "/bin/bash",
	});
const manager = (maxSessionBufferChars?: number) =>
	createExecSessionManager({
		backend: backend(),
		defaultExecYieldTimeMs: 250,
		minNonInteractiveExecYieldTimeMs: 250,
		minEmptyWriteYieldTimeMs: 250,
		maxEmptyWriteYieldTimeMs: 500,
		...(maxSessionBufferChars === undefined ? {} : { maxSessionBufferChars }),
	});

test("session buffer eviction tracks omitted output and IDs do not survive a new runtime", async () => {
	const sessions = manager(1024);
	let id = 0;
	try {
		const start = await sessions.exec(
			{ cmd: `sleep 0.5; printf '%04000d' 0`, login: false },
			cwd,
		);
		assert.ok(start.session_id);
		id = start.session_id;
		const result = await sessions.write({
			session_id: id,
			max_output_tokens: 5000,
		});
		assert.equal(result.output.length, 1024);
		assert.equal(result.original_token_count, 1000);
		assert.equal(result.truncated, true);
	} finally {
		await sessions.shutdown();
	}
	const restarted = manager();
	try {
		await assert.rejects(
			restarted.write({ session_id: id }),
			/expired.*restart/,
		);
	} finally {
		await restarted.shutdown();
	}
});

test("shutdown drains pending native startup", async () => {
	const native = backend();
	let pid = 0;
	const delayed = createExecSessionManager({
		backend: {
			...native,
			spawn: async (request, events) => {
				await delay(40);
				return native.spawn(request, {
					...events,
					output: (stream, bytes) => {
						pid = Number(Buffer.from(bytes).toString().trim());
						events.output(stream, bytes);
					},
				});
			},
		},
		minNonInteractiveExecYieldTimeMs: 250,
	});
	const execution = delayed.exec(
		{ cmd: "echo $$; exec sleep 60", login: false },
		cwd,
	);
	await delay(10);
	await delayed.shutdown();
	assert.equal((await execution).exit_code, 137);
	if (pid) assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test("owned exec cancellation reaps actual pipe and PTY processes", async () => {
	for (const tty of [false, true]) {
		const sessions = manager();
		const controller = new AbortController();
		let pid = 0;
		try {
			const running = sessions.exec(
				{
					cmd: 'printf "%s\\n" "$$"; exec sleep 60',
					tty,
					login: false,
					wait_until_exit: true,
				},
				cwd,
				controller.signal,
				(result) => {
					if (!result.output.trim()) return;
					pid = Number(result.output.trim());
					controller.abort(new Error("cancel shell test"));
				},
			);
			await assert.rejects(running, /cancel shell test/);
			assert.ok(pid > 0);
			assert.throws(() => process.kill(pid, 0), /ESRCH/);
			assert.deepEqual(sessions.listSessions(), []);
		} finally {
			await sessions.shutdown();
		}
	}
});

test("write cancellation, terminal Ctrl-C and shutdown stop owned sessions", async () => {
	const sessions = manager();
	try {
		const start = await sessions.exec(
			{ cmd: "echo $$; exec sleep 60", tty: true, login: false },
			cwd,
		);
		assert.ok(start.session_id);
		const interrupt = await sessions.write({
			session_id: start.session_id,
			chars: "\x03",
			yield_time_ms: 500,
		});
		assert.equal(interrupt.exit_code, 130);
		const pending = await sessions.exec(
			{ cmd: "echo $$; exec sleep 60", login: false },
			cwd,
		);
		assert.ok(pending.session_id);
		const controller = new AbortController();
		const waiting = sessions.write(
			{ session_id: pending.session_id },
			controller.signal,
		);
		await delay(20);
		controller.abort(new Error("cancel poll"));
		await assert.rejects(waiting, /cancel poll/);
		assert.throws(
			() => process.kill(Number(pending.output.trim()), 0),
			/ESRCH/,
		);
		const shutdown = await sessions.exec(
			{ cmd: "echo $$; exec sleep 60", tty: true, login: false },
			cwd,
		);
		await Promise.all([sessions.shutdown(), sessions.shutdown()]);
		assert.throws(
			() => process.kill(Number(shutdown.output.trim()), 0),
			/ESRCH/,
		);
		await assert.rejects(sessions.exec({ cmd: "echo no" }, cwd), /shut down/);
	} finally {
		await sessions.shutdown();
	}
});
