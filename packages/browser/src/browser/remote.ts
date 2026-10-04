import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserArtifacts } from "./artifacts.ts";
import type { BrowserOperation } from "./operation.ts";
import { ensureRemoteHelper, remoteNodeCommand } from "./remote-helper.ts";
import { runProgram } from "./remote-process.ts";
import type { BrowserRoute } from "./routes.ts";

const SAFE_REMOTE_FILE = /^\/[A-Za-z0-9_./-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function copyRemoteArtifact(
	host: string,
	remoteFile: string,
	signal: AbortSignal | undefined,
	artifacts: BrowserArtifacts,
	stateDirectory: string,
): Promise<string> {
	if (!SAFE_REMOTE_FILE.test(remoteFile)) {
		throw new Error(
			`remote browser returned an unsafe artifact path: ${remoteFile}`,
		);
	}
	await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
	const staging = await mkdtemp(join(stateDirectory, "scp-"));
	const localFile = join(staging, "screenshot.png");
	try {
		const copied = await runProgram(
			"scp",
			["-q", `${host}:${remoteFile}`, localFile],
			undefined,
			signal,
		);
		if (copied.code !== 0) {
			throw new Error(
				copied.stderr || copied.stdout || "could not copy remote screenshot",
			);
		}
		const removed = await runProgram(
			"ssh",
			[host, `/usr/bin/rm -- ${remoteFile}`],
			undefined,
			signal,
		);
		if (removed.code !== 0) {
			throw new Error(
				removed.stderr ||
					removed.stdout ||
					"copied screenshot but could not remove remote artifact",
			);
		}
		const target = artifacts.screenshotTarget({ ref_id: host });
		await target.write(await readFile(localFile));
		return target.file;
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}

async function localizeScreenshots(
	host: string,
	operations: BrowserOperation[],
	result: Record<string, unknown>,
	signal: AbortSignal | undefined,
	artifacts: BrowserArtifacts,
	stateDirectory: string,
): Promise<void> {
	for (const [index, operation] of operations.entries()) {
		if (operation.action !== "screenshot") continue;
		const item =
			operations.length === 1
				? result
				: Array.isArray(result["results"])
					? result["results"][index]
					: undefined;
		if (!isRecord(item) || typeof item["file"] !== "string") {
			throw new Error(`remote screenshot result ${index} has no file path`);
		}
		item["file"] = await copyRemoteArtifact(
			host,
			item["file"],
			signal,
			artifacts,
			stateDirectory,
		);
	}
}

export async function executeRemoteBrowser(
	route: BrowserRoute,
	operations: BrowserOperation[],
	ownerId: string,
	signal: AbortSignal | undefined,
	artifacts: BrowserArtifacts,
	stateDirectory: string,
): Promise<Record<string, unknown>> {
	if (!route.remote) {
		throw new Error(`Browser host ${route.name} has no remote command`);
	}
	await ensureRemoteHelper(route.name, route.remote, signal);
	const executed = await runProgram(
		"ssh",
		[route.name, remoteNodeCommand(route.remote)],
		JSON.stringify({ owner_id: ownerId, operations }),
		signal,
	);
	if (executed.code !== 0) {
		throw new Error(
			executed.stderr ||
				executed.stdout ||
				`remote browser exited with code ${executed.code}`,
		);
	}
	let value: unknown;
	try {
		value = JSON.parse(executed.stdout);
	} catch (error) {
		throw new Error(
			`remote browser returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!isRecord(value)) {
		throw new Error("remote browser result is not an object");
	}
	await localizeScreenshots(
		route.name,
		operations,
		value,
		signal,
		artifacts,
		stateDirectory,
	);
	return value;
}
