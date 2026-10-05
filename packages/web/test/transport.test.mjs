import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { unstable_dev } from "wrangler";
import { fetchCodexTool } from "../../../internal/codex/http.ts";

test("ordinary Web tool owns native workerd HTTP, affinity, limits and cancellation", {
	timeout: 45000,
}, async () => {
	const seen = [];
	let markReady;
	const pendingReady = new Promise((resolve) => {
		markReady = resolve;
	});
	let markClosed;
	const pendingClosed = new Promise((resolve) => {
		markClosed = resolve;
	});
	const fixture = createServer(async (request, response) => {
		if (request.url === "/ready") {
			await pendingReady;
			response.end("ready");
			return;
		}
		let text = "";
		for await (const chunk of request) text += chunk;
		seen.push({
			path: request.url,
			headers: request.headers,
			body: JSON.parse(text),
		});
		if (request.url === "/redirect") {
			response.writeHead(307, {
				location: `http://localhost:${fixture.address().port}/destination`,
			});
			response.end();
			return;
		}
		if (request.url === "/cancel") {
			response.on("close", markClosed);
			response.writeHead(200, { "content-type": "application/json" });
			response.write('{"output_text":"');
			markReady();
			return;
		}
		if (request.url === "/challenge") {
			response.writeHead(403, { "cf-mitigated": "challenge" });
			response.end("Cloudflare owned fixture");
			return;
		}
		if (request.url === "/credential-error") {
			response.writeHead(502);
			response.end("owned failure echo: Bearer owned-fixture-not-a-credential");
			return;
		}
		if (request.url === "/large") {
			// No Content-Length, so the bound must apply while streaming too.
			response.writeHead(200, { "content-type": "application/json" });
			response.end('"' + "x".repeat(8 * 1024 * 1024) + '"');
			return;
		}
		response.setHeader("content-type", "application/json");
		response.end(
			JSON.stringify({
				output_text:
					"owned fixture output: Bearer owned-fixture-not-a-credential",
				nested: { echo: "owned-fixture-not-a-credential" },
				search_results: [
					{ url: "https://example.test/owned", ref_id: "owned-turn-ref" },
				],
			}),
		);
	});
	await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${fixture.address().port}`;
	const persistence = await mkdtemp(join(tmpdir(), "durable-web-transport-"));
	let worker;
	try {
		worker = await unstable_dev(
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
		const workflow = async (mode, target = mode) => {
			const response = await worker.fetch(
				`http://web/${mode}?fixture=${encodeURIComponent(`${base}/${target}`)}`,
				{ signal: AbortSignal.timeout(10000) },
			);
			assert.equal(response.status, 200, await response.clone().text());
			return response.json();
		};
		const affinity = await workflow("affinity", "search");
		assert.equal(affinity.receipt.status, "done");
		assert.equal(affinity.observations.length, 2);
		assert.ok(affinity.observations.every((result) => !result.isError));
		assert.ok(
			!JSON.stringify(affinity.observations).includes(
				"owned-fixture-not-a-credential",
			),
		);
		assert.equal(
			affinity.observations[0].details.webRun.nested.echo,
			"[redacted]",
		);
		assert.match(
			JSON.stringify(affinity.observations[0].content),
			/Bearer \[redacted\]/,
		);
		assert.equal(
			affinity.observations[0].details.webRun.search_results[0].ref_id,
			"owned-turn-ref",
		);
		assert.equal(seen[0].body.id, affinity.sessionId);
		assert.equal(seen[1].body.id, affinity.sessionId);
		assert.equal(seen[0].body.max_output_tokens, 2500);
		assert.equal(seen[0].body.model, "gpt-6-luna");
		assert.deepEqual(seen[0].body.commands.custom_command, { retained: true });
		assert.equal(seen[0].body.commands.search_query[0].custom_query, 42);
		assert.equal(seen[0].body.commands.settings, undefined);
		assert.deepEqual(seen[0].body.settings, {
			search_context_size: "high",
			custom_setting: true,
			allowed_callers: ["direct"],
			external_web_access: true,
		});
		assert.deepEqual(seen[1].body.commands.open, [
			{ ref_id: "owned-turn-ref" },
		]);
		assert.equal(
			seen[0].headers.authorization,
			"Bearer owned-fixture-not-a-credential",
		);
		assert.equal(
			seen[0].headers["chatgpt-account-id"],
			"owned-fixture-account",
		);
		assert.match(seen[0].headers["user-agent"], /workerd/);

		const large = await workflow("large");
		assert.equal(large.observations[0].isError, true);
		assert.match(JSON.stringify(large.observations), /exceeded 8388608 bytes/);
		const redirect = await workflow("redirect");
		assert.equal(redirect.observations[0].isError, false);
		const destination = seen.find((entry) => entry.path === "/destination");
		assert.equal(destination.headers.authorization, undefined);
		assert.equal(destination.headers["chatgpt-account-id"], undefined);
		assert.equal(destination.body.id, redirect.sessionId);
		const challenge = await workflow("challenge");
		assert.equal(challenge.observations[0].isError, true);
		assert.match(
			JSON.stringify(challenge.observations),
			/HTTP 403 Cloudflare challenge/,
		);
		assert.equal(seen.filter((entry) => entry.path === "/challenge").length, 1);
		const credentialError = await workflow("credential-error");
		assert.equal(credentialError.observations[0].isError, true);
		assert.match(
			JSON.stringify(credentialError.observations),
			/HTTP 502 owned failure echo: Bearer \[redacted\]/,
		);
		assert.ok(
			!JSON.stringify(credentialError.observations).includes(
				"owned-fixture-not-a-credential",
			),
		);

		const cancelled = await workflow("cancel");
		assert.equal(cancelled.receipt.reason, "aborted");
		await new Promise((resolve, reject) => {
			const timeout = setTimeout(
				() => reject(new Error("Owned HTTP did not close")),
				1000,
			);
			pendingClosed.then(() => {
				clearTimeout(timeout);
				resolve();
			}, reject);
		});
	} finally {
		await worker?.stop();
		fixture.closeAllConnections();
		await new Promise((resolve, reject) =>
			fixture.close((error) => (error ? reject(error) : resolve())),
		);
		await rm(persistence, { recursive: true, force: true });
	}
});

test("default Node transport follows redirects without forwarding credentials", async () => {
	let destination;
	const fixture = createServer(async (request, response) => {
		if (request.url === "/start") {
			response.writeHead(303, {
				location: `http://localhost:${fixture.address().port}/end`,
			});
			response.end();
			return;
		}
		destination = { method: request.method, headers: request.headers };
		response.end("Node owned fixture");
	});
	await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
	try {
		const response = await fetchCodexTool(
			`http://127.0.0.1:${fixture.address().port}/start`,
			{
				method: "POST",
				body: "{}",
				headers: new Headers({
					authorization: "Bearer fixture",
					"chatgpt-account-id": "fixture",
					"content-type": "application/json",
				}),
				signal: AbortSignal.timeout(1000),
			},
		);
		assert.equal(response.text, "Node owned fixture");
		assert.equal(destination.method, "GET");
		assert.equal(destination.headers.authorization, undefined);
		assert.equal(destination.headers["chatgpt-account-id"], undefined);
		assert.equal(destination.headers["content-type"], undefined);
	} finally {
		fixture.closeAllConnections();
		await new Promise((resolve, reject) =>
			fixture.close((error) => (error ? reject(error) : resolve())),
		);
	}
});
