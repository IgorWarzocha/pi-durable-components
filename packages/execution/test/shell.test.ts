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

test("pipe stream codecs, stdin closure, failure result and output bounds", async () => {
	const sessions = manager();
	try {
		const splitUtf8 = `node -e 'process.stdout.write(Buffer.from([0xf0,0x9f])); process.stderr.write(Buffer.from([0xe2])); setTimeout(()=>{process.stdout.write(Buffer.from([0x98,0x83])); process.stderr.write(Buffer.from([0x82,0xac]));},30)'`;
		const result = await sessions.exec({ cmd: splitUtf8, login: false }, cwd);
		assert.equal(result.exit_code, 0);
		assert.deepEqual(Array.from(result.output).sort(), ["€", "😃"].sort());
		assert.ok(result.wall_time_seconds >= 0);
		assert.match(result.chunk_id, /^[0-9a-f]{6}$/);
		const closed = await sessions.exec(
			{ cmd: 'read x; printf "read:%s" "$?"', login: false },
			cwd,
		);
		assert.equal(closed.output, "read:1");
		const failure = await sessions.exec(
			{ cmd: "anything", shell: "/no/such/shell" },
			cwd,
		);
		assert.equal(failure.exit_code, 1);
		assert.match(failure.output, /ENOENT/);
		const ttyFailure = await sessions.exec(
			{ cmd: "anything", shell: "/no/such/shell", tty: true },
			cwd,
		);
		assert.equal(ttyFailure.exit_code, 1);
		assert.match(ttyFailure.output, /No such file or directory/);
		assert.deepEqual(sessions.listSessions(), []);
		const bounded = await sessions.exec(
			{ cmd: `printf '%01000d' 0`, max_output_tokens: 1, login: false },
			cwd,
		);
		assert.equal(bounded.output.length, 256);
		assert.equal(bounded.original_token_count, 250);
		assert.equal(bounded.truncated, true);
	} finally {
		await sessions.shutdown();
	}
});

test("PTY really exposes a terminal, keeps raw output and accepts stdin", async () => {
	const sessions = manager();
	try {
		const start = await sessions.exec(
			{
				cmd: 'test -t 0 && printf "terminal\\n"; read -r line; printf "got:%s\\n" "$line"',
				tty: true,
				login: false,
			},
			cwd,
		);
		assert.match(start.output, /terminal\r\n/);
		assert.ok(start.session_id);
		const result = await sessions.write({
			session_id: start.session_id,
			chars: "😃\n",
			yield_time_ms: 500,
		});
		assert.equal(result.exit_code, 0);
		assert.match(result.output, /got:😃\r\n/);
		const replay = await sessions.write({ session_id: start.session_id });
		assert.equal(replay.chunk_id, result.chunk_id);
		assert.match(replay.output, /got:😃/);
		await assert.rejects(
			sessions.write({ session_id: start.session_id, chars: "no" }),
			/already exited/,
		);
	} finally {
		await sessions.shutdown();
	}
});

test("non-TTY continuation rejects writes and retained replay does not bound exit delivery", async () => {
	const sessions = manager();
	try {
		const start = await sessions.exec(
			{ cmd: `sleep 0.7; printf '%090000d' 0`, login: false },
			cwd,
		);
		assert.ok(start.session_id);
		await assert.rejects(
			sessions.write({ session_id: start.session_id, chars: "no" }),
			/tty=true/,
		);
		const result = await sessions.write({
			session_id: start.session_id,
			max_output_tokens: 30_000,
		});
		assert.equal(result.exit_code, 0);
		assert.equal(result.output.length, 90_000);
		const replay = await sessions.write({
			session_id: start.session_id,
			max_output_tokens: 30_000,
		});
		assert.equal(replay.truncated, true);
		assert.ok(replay.output.length <= 64 * 1024);
		assert.equal(replay.original_token_count, 22_500);
	} finally {
		await sessions.shutdown();
	}
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

test("output extends non-interactive waits, empty polls grow, and shutdown drains pending startup", async () => {
	const sessions = manager();
	try {
		const result = await sessions.exec(
			{
				cmd: `for n in 1 2 3 4 5 6; do printf x; sleep 0.1; done`,
				login: false,
				max_yield_time_ms: 1200,
			},
			cwd,
		);
		assert.equal(result.exit_code, 0);
		assert.equal(result.output, "xxxxxx");
		assert.ok(result.wall_time_seconds >= 0.5);
		const start = await sessions.exec(
			{ cmd: "exec sleep 60", login: false },
			cwd,
		);
		assert.ok(start.session_id);
		const poll = await sessions.write({
			session_id: start.session_id,
			yield_time_ms: 1,
		});
		assert.equal(poll.session_id, start.session_id);
		assert.ok(poll.wall_time_seconds >= 0.4);
		assert.equal(sessions.terminateSession(start.session_id), true);
		const done = await sessions.write({ session_id: start.session_id });
		assert.equal(done.exit_code, 137);
	} finally {
		await sessions.shutdown();
	}
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
