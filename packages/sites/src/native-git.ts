// Adapted from pi-chatgpt-sites at 69f50cf70e8a7b05c2349be6227f521b6504f80e.
// Copyright (c) 2026 pasky and Igor Warzocha. MIT licensed.
// Modified for Durable-native registration and explicit execution capabilities.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import type { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

export type RunGit = (
	cwd: string,
	args: string[],
	env?: NodeJS.ProcessEnv,
	signal?: AbortSignal,
) => Promise<string>;

export async function pushCommit({
	root,
	commitSha,
	credential,
	git,
	signal,
}: {
	root: string;
	commitSha: string;
	credential: unknown;
	git: RunGit;
	signal: AbortSignal | undefined;
}) {
	const values = isRecord(credential) ? credential : {};
	const remoteUrl = values["remote_url"];
	const branch = values["branch"];
	const token = values["token"];
	const authMode = String(values["auth_mode"] ?? "").toLowerCase();
	if (
		typeof remoteUrl !== "string" ||
		!remoteUrl ||
		typeof branch !== "string" ||
		!branch ||
		typeof token !== "string" ||
		!token
	) {
		throw new Error(
			"Sites returned an incomplete source repository credential",
		);
	}
	const url = new URL(remoteUrl);
	if (url.protocol !== "https:" || url.username || url.password) {
		throw new Error(
			"Sites source repository URL must be credential-free HTTPS",
		);
	}
	await git(
		root,
		["check-ref-format", `refs/heads/${branch}`],
		process.env,
		signal,
	);

	const env: NodeJS.ProcessEnv = {
		...process.env,
		GIT_TERMINAL_PROMPT: "0",
		SITES_GIT_TOKEN: token,
	};
	let askPassDirectory: string | undefined;
	try {
		if (authMode.includes("bearer")) {
			env["GIT_CONFIG_COUNT"] = "1";
			env["GIT_CONFIG_KEY_0"] = "http.extraHeader";
			env["GIT_CONFIG_VALUE_0"] = `Authorization: Bearer ${token}`;
		} else {
			askPassDirectory = await mkdtemp(join(tmpdir(), "pi-sites-askpass-"));
			const askPass = join(askPassDirectory, "askpass");
			await writeFile(
				askPass,
				`#!${process.execPath}\nconst prompt = process.argv.slice(2).join(" ").toLowerCase();\nprocess.stdout.write(prompt.includes("username") ? "x-access-token" : process.env.SITES_GIT_TOKEN || "");\n`,
				{ mode: 0o700 },
			);
			env["GIT_ASKPASS"] = askPass;
			env["SITES_GIT_TOKEN"] = token;
			env["SITES_GIT_USERNAME"] = "x-access-token";
		}
		await git(
			root,
			[
				"-c",
				"http.followRedirects=false",
				"-c",
				"credential.helper=",
				"-c",
				"core.hooksPath=/dev/null",
				"push",
				"--no-verify",
				"--porcelain",
				remoteUrl,
				`${commitSha}:refs/heads/${branch}`,
			],
			env,
			signal,
		);
	} catch (error) {
		throw Object.assign(
			new Error(
				`${error instanceof Error ? error.message : "Source push failed"}. Source push outcome may be uncertain; inspect state before another side effect`,
			),
			{ code: "outcome_uncertain", topic: "version" },
		);
	} finally {
		if (askPassDirectory)
			await rm(askPassDirectory, { recursive: true, force: true });
	}
}

export function gitForContext(
	environment: NodeExecutionEnv,
	context: Context,
): RunGit {
	return async (cwd, args, env = process.env) => {
		if (!isAbsolute(cwd))
			throw new Error("Git working directory must be absolute");
		let stdout = "";
		let stderr = "";
		let bytes = 0;
		try {
			const result = getOrThrow(
				await environment.exec(
					["git", ...args],
					{
						cwd,
						env: Object.fromEntries(
							Object.entries(env).filter(
								(entry): entry is [string, string] => entry[1] !== undefined,
							),
						),
						inheritEnv: false,
						timeout: 120_000,
						onOutput(text, _context, info) {
							bytes += Buffer.byteLength(text);
							if (bytes > 1024 * 1024)
								throw new Error("Git output exceeded the 1 MiB limit");
							if (info.stream === "stdout") stdout += text;
							else stderr += text;
						},
					},
					context,
				),
			);
			if (result.exitCode !== 0)
				throw new Error(stderr || "Git command failed");
			return stdout;
		} catch (error) {
			const detail = String(
				stderr ||
					(error instanceof Error ? error.message : "Git command failed"),
			)
				.replaceAll(env["SITES_GIT_TOKEN"] || "\0", "[redacted]")
				.replaceAll(env["GIT_CONFIG_VALUE_0"] || "\0", "[redacted]")
				.trim();
			throw new Error(detail.slice(0, 2_000));
		}
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
