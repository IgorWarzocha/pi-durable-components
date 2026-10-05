import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { unstable_dev } from "wrangler";
import { fetchCodexTool } from "../../../internal/codex/http.ts";
import { ChatGptCloudflareCookieStore } from "../src/index.ts";

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
		if (request.url === "/cookie-search") {
			response.setHeader("set-cookie", [
				"__cf_bm=owned-host-cookie-secret; Path=/; Expires=Fri, 01 Jan 2038 00:00:00 GMT; Secure; HttpOnly",
				"_cfuvid=owned-domain-cookie-secret; Domain=.chatgpt.com; Path=/; Secure; HttpOnly",
				"__cfseq=0; Path=/; Secure; HttpOnly",
				"login_session=not-a-permitted-cookie; Path=/; Secure; HttpOnly",
			]);
			response.writeHead(307, {
				location: JSON.parse(text).commands.open
					? "https://sub.chatgpt.com/cookie-open"
					: "https://chatgpt.com/cookie-ready",
			});
			response.end();
			return;
		}
		if (request.url === "/cookie-ready" || request.url === "/cookie-open") {
			response.setHeader("content-type", "application/json");
			response.end(
				JSON.stringify({
					output_text: "owned-host-cookie-secret owned-domain-cookie-secret",
					cost: 0,
					short_cookie_echo: "0",
					search_results: [
						{ url: "https://example.test/owned", ref_id: "owned-turn-ref" },
					],
				}),
			);
			return;
		}
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

		const cookies = await workflow("cookies");
		assert.ok(cookies.observations.every((result) => !result.isError));
		assert.equal(cookies.observations.length, 2);
		const cookieRequests = seen.filter((entry) =>
			entry.path.startsWith("/cookie-"),
		);
		assert.equal(cookieRequests.length, 4);
		assert.equal(cookieRequests[0].headers.cookie, undefined);
		assert.equal(
			cookieRequests[1].headers.cookie,
			"__cf_bm=owned-host-cookie-secret; _cfuvid=owned-domain-cookie-secret; __cfseq=0",
		);
		assert.equal(
			cookieRequests[2].headers.cookie,
			cookieRequests[1].headers.cookie,
		);
		assert.equal(
			cookieRequests[3].headers.cookie,
			"_cfuvid=owned-domain-cookie-secret",
		);
		assert.equal(cookieRequests[3].headers.authorization, undefined);
		assert.equal(cookieRequests[3].headers["chatgpt-account-id"], undefined);
		assert.ok(!JSON.stringify(cookies.observations).includes("cookie-secret"));
		assert.match(JSON.stringify(cookies.observations), /\[redacted\]/);
		assert.equal(cookies.observations[0].details.webRun.cost, 0);
		assert.equal(
			cookies.observations[0].details.webRun.short_cookie_echo,
			"[redacted]",
		);
		const countBeforeEgressFailure = seen.length;
		const egressFailure = await workflow("egress-failure");
		assert.match(
			JSON.stringify(egressFailure.observations),
			/Configured Worker egress unavailable/,
		);
		assert.equal(
			seen.length,
			countBeforeEgressFailure,
			"host egress failures must not fall back to native fetch",
		);

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

test("service cookie snapshots retain policy, expiry and atomic rejection without browser-cookie imports", () => {
	const url = new URL("https://chatgpt.com/backend-api/codex/alpha/search");
	const jar = new ChatGptCloudflareCookieStore();
	jar.storeResponse(url, [
		"__cf_bm=host-cookie; Path=/backend-api; Secure; HttpOnly",
		"_cfuvid=domain-cookie; Domain=.chatgpt.com; Path=/; Secure",
		"login_session=ignored; Path=/",
		"__cflb=wrong-domain; Domain=example.com; Path=/",
		"cf_clearance=expired; Max-Age=-1; Path=/",
	]);
	const reopened = new ChatGptCloudflareCookieStore(
		JSON.parse(JSON.stringify(jar.snapshot())),
	);
	assert.equal(
		reopened.requestHeader(url),
		"__cf_bm=host-cookie; _cfuvid=domain-cookie",
	);
	assert.equal(
		reopened.requestHeader(new URL("https://sub.chatgpt.com/backend-api")),
		"_cfuvid=domain-cookie",
	);
	assert.equal(
		reopened.requestHeader(new URL("http://chatgpt.com/backend-api")),
		undefined,
	);
	assert.equal(
		reopened.requestHeader(new URL("https://chatgpt.com/backend-apix")),
		"_cfuvid=domain-cookie",
	);
	assert.equal(
		reopened.requestHeader(new URL("https://chatgpt.com.example.com/")),
		undefined,
	);
	const before = reopened.snapshot();
	assert.throws(
		() =>
			reopened.storeResponse(url, [
				"__cf_bm=" + "x".repeat(65536) + "; Path=/",
			]),
		/exceeded/,
	);
	assert.deepEqual(reopened.snapshot(), before);
	assert.throws(
		() =>
			new ChatGptCloudflareCookieStore([
				{ ...before[0], domain: "example.com" },
			]),
		/Invalid stored/,
	);
	reopened.storeResponse(url, [
		"__cf_bm=deleted; Path=/backend-api; Max-Age=0; Expires=Fri, 01 Jan 2038 00:00:00 GMT",
	]);
	assert.equal(reopened.requestHeader(url), "_cfuvid=domain-cookie");
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
