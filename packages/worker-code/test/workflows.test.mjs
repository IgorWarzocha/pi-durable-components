import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { unstable_dev } from "wrangler";

test("bounded compiled WASM, genuine Durable nested handlers, yield/wait and cancellation execute on workerd", {
	timeout: 45000,
}, async () => {
	const persistence = await mkdtemp(join(tmpdir(), "worker-code-contract-"));
	const worker = await unstable_dev(
		fileURLToPath(new URL("./worker.ts", import.meta.url)),
		{
			config: fileURLToPath(new URL("./wrangler.jsonc", import.meta.url)),
			port: 0,
			inspectorPort: 0,
			local: true,
			persistTo: persistence,
			logLevel: "error",
			experimental: {
				disableExperimentalWarning: true,
				disableDevRegistry: true,
				watch: false,
			},
		},
	);
	try {
		const fetchWorkflow = async (path) => {
			const response = await worker.fetch(`http://worker-code${path}`, {
				signal: AbortSignal.timeout(10000),
			});
			const body = await response.json();
			assert.equal(response.status, 200, JSON.stringify(body));
			return body;
		};
		const runtime = await fetchWorkflow("/runtime");
		assert.equal(runtime.arithmetic, 42);
		assert.deepEqual(runtime.isolated, Array(10).fill("undefined"));
		assert.equal(runtime.imported, 42);
		assert.equal(runtime.constructor, "undefined");
		assert.equal(runtime.fresh, "undefined");
		assert.deepEqual(runtime.manifest, { name: "site_test" });
		assert.match(runtime.errors.fuel, /interrupted/);
		assert.match(runtime.errors.jobs, /job limit/);
		assert.match(runtime.errors.heap, /out of memory/);
		assert.match(runtime.errors.module, /not in the workspace snapshot/);
		assert.match(
			runtime.errors.escape,
			/escapes root|not in the workspace snapshot/,
		);
		assert.match(runtime.errors.result, /Return value byte limit/);
		assert.match(runtime.errors.deadPromise, /no owned host work/);
		for (let attempt = 0; attempt < 4; attempt++)
			assert.match(
				runtime.errors[`startup${attempt}`],
				/Invalid Worker Code limit heapBytes/,
			);
		assert.equal(runtime.recovered, 42);
		assert.equal(runtime.instantiateStreaming, "undefined");
		assert.equal(runtime.budget.activeRuntimes, 0);
		assert.ok(runtime.budget.wasmMemoryBytes <= runtime.budget.maxWasmBytes);

		const durable = await fetchWorkflow("/durable");
		assert.equal(durable.effects, 2);
		assert.equal(durable.wrapped, 2);
		assert.equal(durable.maxActive, 2);
		assert.ok(durable.before >= 6);
		assert.ok(durable.after >= 5);
		assert.equal(durable.observations.length, 3);
		assert.equal(durable.observations[0].details.status, "running");
		assert.equal(durable.observations[0].content[1].text, "before");
		assert.equal(durable.observations[1].details.status, "running");
		assert.equal(
			durable.observations[1].content.length,
			1,
			"unchanged running observation must not repeat output",
		);
		assert.equal(durable.observations[2].details.status, "completed");
		const final = JSON.parse(durable.observations[2].content[1].text);
		assert.deepEqual(
			final.nested.details.results.map((result) => result.details.doubled),
			[42, 4],
		);
		assert.equal(
			final.nested.details.results[0].content[0].text,
			"complete result",
		);
		assert.equal(
			final.nested.details.results[0].diagnostics[0].code,
			"ordinary_info",
		);
		assert.equal(final.nested.details.results[0].usage.totalTokens, 3);
		assert.deepEqual(final.nested.control.addTools, ["ordinary-tool"]);
		assert.equal(final.invalid.diagnostics[0].code, "invalid_arguments");
		assert.equal(final.blocked.diagnostics[0].code, "blocked");
		assert.deepEqual(final.inventory.sort(), [
			"ordinary-tool",
			"site_editable",
		]);
		assert.equal(durable.budget.activeRuntimes, 0);

		const cancelled = await fetchWorkflow("/cancel");
		assert.equal(cancelled.started, 1);
		assert.equal(cancelled.cancelled, 1);
		assert.equal(cancelled.receipt.reason, "aborted");
		assert.deepEqual(cancelled.inspection.tasks, []);
		assert.deepEqual(cancelled.inspection.submissions, []);
		assert.equal(cancelled.budget.activeRuntimes, 0);

		const terminated = await fetchWorkflow("/terminate");
		assert.equal(terminated.started, 1);
		assert.equal(terminated.cancelled, 1);
		assert.equal(terminated.observations[0].details.status, "aborted");
		assert.deepEqual(terminated.inspection.tasks, []);
		assert.equal(terminated.budget.activeRuntimes, 0);

		const admission = await fetchWorkflow("/admission");
		for (const pass of admission) {
			assert.equal(pass.started, pass.capacity);
			assert.equal(pass.cancelled, pass.capacity);
			assert.equal(pass.budget.activeRuntimes, pass.capacity);
			assert.equal(
				pass.budget.reservedHeapBytes,
				pass.capacity * pass.heapBytes,
			);
			assert.match(
				JSON.stringify(pass.observations),
				/isolate runtime budget exhausted/,
			);
			assert.equal(pass.after.activeRuntimes, 0);
			assert.equal(pass.after.reservedHeapBytes, 0);
			assert.ok(pass.after.wasmMemoryBytes <= 32 * 1024 * 1024);
		}
	} finally {
		await worker.stop();
		await rm(persistence, { recursive: true, force: true });
	}
});
