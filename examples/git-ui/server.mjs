import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createNativeGitReader } from "@howaboua/pi-durable-git/native";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cwd = resolve(process.argv[2] ?? process.cwd());
const port = Number(process.env["PORT"] ?? 4318);
const origin = `http://127.0.0.1:${port}`;
const token = randomBytes(24).toString("hex");
const reader = createNativeGitReader();
if (!(await reader.isRepository(cwd)))
	throw new Error(`Not a Git worktree: ${cwd}`);
execFileSync(
	"bun",
	[
		"build",
		"examples/git-ui/client.ts",
		"--target=browser",
		"--splitting",
		"--outdir=dist/git-ui",
	],
	{ cwd: root, stdio: ["ignore", "ignore", "inherit"] },
);

const server = createServer(async (request, response) => {
	const abort = new AbortController();
	response.on("close", () => {
		if (!response.writableEnded) abort.abort();
	});
	response.setHeader("Cache-Control", "no-store");
	response.setHeader("X-Content-Type-Options", "nosniff");
	try {
		if (request.method === "GET" && request.url === "/") {
			response.setHeader("Content-Type", "text/html; charset=utf-8");
			response.end(
				`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="rpc-token" content="${token}"><title>Git UI host</title><style>body{margin:0;font:14px system-ui;color-scheme:light dark}nav{display:flex;gap:12px;padding:12px;align-items:center;flex-wrap:wrap}#view{height:calc(100dvh - 60px)}button,select{font:inherit}output{margin-left:auto}</style><nav aria-label="Host controls"><strong>Git UI host</strong><button id="mount">Mount</button><button id="dispose">Unmount</button><output id="status" aria-live="polite"></output></nav><main id="view"></main><script type="module" src="/client.js"></script></html>`,
			);
			return;
		}
		if (
			request.method === "GET" &&
			/^\/[a-zA-Z0-9_.-]+\.js$/.test(request.url ?? "")
		) {
			response.setHeader("Content-Type", "text/javascript; charset=utf-8");
			response.end(
				await readFile(resolve(root, "dist/git-ui", request.url.slice(1))),
			);
			return;
		}
		if (request.method !== "POST" || request.url !== "/rpc") {
			response.writeHead(404).end("Not found");
			return;
		}
		if (
			request.headers.origin !== origin ||
			request.headers.authorization !== `Bearer ${token}`
		) {
			response.writeHead(403).end("Forbidden");
			return;
		}
		let body = "";
		for await (const chunk of request) {
			body += chunk.toString();
			if (body.length > 4096) throw new Error("Request too large");
		}
		const input = JSON.parse(body);
		if (
			input.method !== "git.diff" ||
			!input.input ||
			Array.isArray(input.input) ||
			typeof input.input !== "object" ||
			Object.keys(input.input).length !== 0
		)
			throw new Error("Only git.diff with an empty input is supported");
		// No client-provided filesystem paths. This host grants access to one explicit repository.
		const result = await reader.diff(
			{ cwd, includeUntracked: true },
			{ signal: abort.signal },
		);
		response.setHeader("Content-Type", "application/json");
		response.end(JSON.stringify(result));
	} catch (error) {
		if (abort.signal.aborted) return;
		response
			.writeHead(500, { "Content-Type": "text/plain" })
			.end(error instanceof Error ? error.message : String(error));
	}
});
server.listen(port, "127.0.0.1", () =>
	console.log(`Git UI host: ${origin}\nRepository: ${cwd}`),
);
