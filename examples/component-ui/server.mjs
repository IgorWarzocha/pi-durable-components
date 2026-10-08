import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dispatch } from "./channel.mjs";
import { reviewChannel } from "./review.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cwd = resolve(
	process.argv[2] ?? (await mkdtemp(join(tmpdir(), "durable-ui-workspace-"))),
);
if (!process.argv[2]) execFileSync("git", ["init", cwd], { stdio: "ignore" });
const store = resolve(
	process.argv[3] ??
		join(await mkdtemp(join(tmpdir(), "durable-ui-store-")), "comments.json"),
);
const port = Number(process.env["PORT"] ?? 4319);
const origin = `http://127.0.0.1:${port}`;
const token = randomBytes(24).toString("hex");
execFileSync(
	"bun",
	[
		"build",
		"examples/component-ui/client.ts",
		"--target=browser",
		"--outdir=dist/component-ui",
	],
	{ cwd: root, stdio: "inherit" },
);
const review = await reviewChannel(cwd, store);
const channels = new Map([["review", review]]);
const connections = new Set();
const server = createServer(async (request, response) => {
	const abort = new AbortController();
	connections.add(abort);
	response.on("close", () => {
		connections.delete(abort);
		abort.abort();
	});
	response.setHeader("Cache-Control", "no-store");
	response.setHeader("X-Content-Type-Options", "nosniff");
	response.setHeader(
		"Content-Security-Policy",
		"default-src 'self'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
	);
	try {
		if (request.method === "GET" && request.url === "/") {
			if (request.headers.host !== `127.0.0.1:${port}`) {
				response.writeHead(403).end();
				return;
			}
			response.setHeader("Content-Type", "text/html; charset=utf-8");
			response.end(
				`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="rpc-token" content="${token}"><title>Durable component workspace</title><style>body{margin:24px;font:15px system-ui;background:#f7f5f0;color:#242820}main{display:grid;grid-template-columns:1fr;gap:28px}section{min-width:0;border-top:3px solid #395b44}textarea{width:100%;box-sizing:border-box;min-height:110px;font:14px monospace}button,select,input{font:inherit;padding:6px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px monospace;max-height:420px;overflow:auto}label{display:block;margin:12px 0}output{display:block;margin:10px 0}button{margin-right:6px}select{max-width:100%}@media(max-width:800px){main{grid-template-columns:1fr}}:focus-visible{outline:3px solid #a56020}</style><h1>Durable component workspace</h1><p>Revision-anchored Git review through the UI SDK.</p><button id="lifecycle">Unmount components</button><output id="host-status" aria-live="polite"></output><main><section id="review"></section></main><script type="module" src="/client.js"></script></html>`,
			);
			return;
		}
		if (request.method === "GET" && request.url === "/client.js") {
			response.setHeader("Content-Type", "text/javascript; charset=utf-8");
			response.end(await readFile(join(root, "dist/component-ui/client.js")));
			return;
		}
		if (
			request.headers.host !== `127.0.0.1:${port}` ||
			(request.headers.origin !== undefined &&
				request.headers.origin !== origin) ||
			(request.headers.origin === undefined &&
				request.headers["sec-fetch-site"] !== "same-origin") ||
			request.headers.authorization !== `Bearer ${token}`
		) {
			response.writeHead(403).end("Forbidden");
			return;
		}
		await dispatch(channels, request, response, abort.signal);
	} catch (error) {
		if (abort.signal.aborted) return;
		if (response.headersSent) response.destroy(error);
		else
			response
				.writeHead(400, { "Content-Type": "text/plain" })
				.end(String(error));
	}
});
server.listen(port, "127.0.0.1", () =>
	console.log(
		`Component UI: ${origin}\nWorkspace: ${cwd}\nComment store: ${store}`,
	),
);
let closing = false;
async function close() {
	if (closing) return;
	closing = true;
	for (const abort of connections) abort.abort();
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
	await review.close();
}
for (const event of ["SIGINT", "SIGTERM"])
	process.on(event, () => {
		void close().catch((error) => {
			console.error(error);
			process.exitCode = 1;
		});
	});
