import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { setTimeout } from "node:timers/promises";
import type { Model } from "@earendil-works/pi-ai";

// These event shapes are verified against the pinned conversion source's
// native-freeform-contract and openai-codex-test-support fixtures. This server
// tests owned wire decisions, not compatibility with the live OpenAI service.
const serverSource = String.raw`
import { zstdDecompressSync } from "node:zlib";
let sequence = 0;
let socketSequence = 0;
let mode = "normal";
const records = [];
const closed = [];
function events(body) {
  const id = "resp_" + (++sequence);
  const item = { type: "message", id: "msg_" + sequence, role: "assistant", status: "completed", content: [{ type: "output_text", text: "completed", annotations: [] }] };
  const startItem = { ...item, content: [] };
  const output = [
    { type: "response.created", response: { id } },
    { type: "response.output_item.added", output_index: 0, item: startItem },
  ];
  output.push({ type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
  output.push({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "completed" });
  output.push({ type: "response.output_text.done", output_index: 0, content_index: 0, delta: "completed" });
  output.push({ type: "response.output_item.done", output_index: 0, item });
  output.push({ type: "response.completed", response: { id, status: "completed", output: [item], usage: {
    input_tokens: 20, output_tokens: 4, total_tokens: 24,
    input_tokens_details: { cached_tokens: 7, cache_write_tokens: 3 },
    output_tokens_details: { reasoning_tokens: 1 }
  } } });
  return output;
}
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request, server) {
    const path = new URL(request.url).pathname;
    if (path === "/records") return Response.json({ records, closed });
    if (path === "/mode") { mode = await request.text(); return new Response("ok"); }
    if (request.headers.get("upgrade") === "websocket") {
      if (server.upgrade(request, { data: { socket: ++socketSequence, path, headers: Object.fromEntries(request.headers) } })) return;
      return new Response("Cannot upgrade", { status: 400 });
    }
    const bytes = Buffer.from(await request.arrayBuffer());
    const body = JSON.parse((request.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(bytes) : bytes).toString());
    records.push({ transport: "sse", path, headers: Object.fromEntries(request.headers), body });
    const output = events(body);
    return new Response(output.map(event => "data: " + JSON.stringify(event) + "\n\n").join(""), { headers: { "content-type": "text/event-stream" } });
  },
  websocket: {
    message(socket, data) {
      const body = JSON.parse(String(data));
      const record = { transport: "websocket", socket: socket.data.socket, path: socket.data.path, headers: socket.data.headers, body };
      records.push(record);
      if (mode === "hold") { socket.send(JSON.stringify({ type: "response.created", response: { id: "resp_held" } })); return; }
      const output = events(body);
      record.output = output.at(-1).response.output;
      for (const event of output) socket.send(JSON.stringify(event));
    },
    close(socket) { closed.push(socket.data.socket); },
  },
});
console.log(server.url.origin);
`;

interface WireRequest {
	transport: "websocket" | "sse" | "upgrade";
	socket?: number;
	output?: Record<string, unknown>[];
	path?: string;
	headers: Record<string, string>;
	body: {
		input: Record<string, unknown>[];
		previous_response_id?: string;
		instructions?: string;
		tools?: Record<string, unknown>[];
		client_metadata?: Record<string, string>;
		[key: string]: unknown;
	};
}

export async function protocolFixture() {
	const child = spawn("bun", ["--eval", serverSource], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const lines = createInterface({ input: child.stdout });
	const startup = once(lines, "line");
	const exited = once(child, "exit").then(([code]) => {
		throw new Error(`Protocol fixture exited ${code}: ${stderr}`);
	});
	const [url] = await Promise.race([startup, exited]);
	assert.equal(typeof url, "string");
	const baseUrl: string = url;
	return {
		baseUrl,
		async mode(value: string) {
			const response = await fetch(`${baseUrl}/mode`, {
				method: "POST",
				body: value,
			});
			assert.ok(response.ok);
		},
		async records() {
			const value: unknown = await (await fetch(`${baseUrl}/records`)).json();
			assert.ok(
				value &&
					typeof value === "object" &&
					"records" in value &&
					"closed" in value,
			);
			assert.ok(Array.isArray(value.records) && Array.isArray(value.closed));
			for (const record of value.records) {
				assert.ok(record && typeof record === "object");
				assert.ok(["sse", "websocket", "upgrade"].includes(record.transport));
				assert.ok(Array.isArray(record.body.input));
				if (record.transport === "websocket")
					assert.equal(typeof record.socket, "number");
			}
			return {
				requests: value.records as WireRequest[],
				closed: value.closed as number[],
			};
		},
		async waitFor(count: number) {
			for (let attempt = 0; attempt < 200; attempt++) {
				const records = await this.records();
				if (records.requests.length >= count) return records;
				await setTimeout(10);
			}
			throw new Error(`Protocol fixture did not receive ${count} requests`);
		},
		async waitForClosed(sockets: number[]) {
			for (let attempt = 0; attempt < 200; attempt++) {
				const { closed } = await this.records();
				if (sockets.every((socket) => closed.includes(socket))) return;
				await setTimeout(10);
			}
			throw new Error(`Protocol fixture still has open sockets: ${sockets}`);
		},
		async close() {
			lines.close();
			if (child.exitCode === null) {
				const stopped = once(child, "exit");
				child.kill("SIGTERM");
				await stopped;
			}
		},
	};
}

export function localModel(
	baseUrl: string,
	id = "gpt-5.4",
): Model<"openai-codex-responses"> {
	return {
		id,
		name: id,
		provider: "local-codex",
		api: "openai-codex-responses",
		baseUrl,
		input: ["text"],
		reasoning: true,
		contextWindow: 272_000,
		maxTokens: 8_000,
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
	};
}

export const apiKey = `header.${Buffer.from(
	JSON.stringify({
		"https://api.openai.com/auth": { chatgpt_account_id: "local-account" },
	}),
).toString("base64url")}.signature`;
