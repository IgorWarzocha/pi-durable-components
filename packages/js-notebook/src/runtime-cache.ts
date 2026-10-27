// Adapted from Pi Stuff 84bd5bce code-mode/npm-cache.ts, MIT. See ../NOTICE.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { acquireDirectoryLock } from "../../notebook/src/directory-lock.ts";

const run = promisify(execFile);

/** Install only the pinned runtime payloads, without scripts or a global npm cache. */
export async function cacheRuntimePackage(
	name: string,
	version: string,
	cacheDirectory: string,
	signal?: AbortSignal,
): Promise<string> {
	signal?.throwIfAborted();
	const identity = `${name}@${version}`;
	const cwd = join(
		cacheDirectory,
		createHash("sha256").update(identity).digest("hex"),
	);
	await mkdir(cwd, { recursive: true, mode: 0o700 });
	const lock = await acquireDirectoryLock(`${cwd}.lock`, {
		waitMs: 180_000,
		staleMs: 60_000,
		pollMs: 100,
		signal,
	});
	if (!lock) throw new Error(`Could not prepare ${identity}`);
	try {
		const manifest = join(cwd, "node_modules", name, "package.json");
		const completed = join(cwd, ".installed");
		let installed = false;
		try {
			const value: unknown = JSON.parse(await readFile(manifest, "utf8"));
			installed =
				!!value &&
				typeof value === "object" &&
				"name" in value &&
				value.name === name &&
				"version" in value &&
				value.version === version &&
				(await readFile(completed, "utf8")) === identity;
		} catch (error) {
			if (
				!(error instanceof Error && "code" in error && error.code === "ENOENT")
			)
				throw error;
		}
		if (!installed) {
			await writeFile(
				join(cwd, "package.json"),
				JSON.stringify({
					private: true,
					type: "module",
					dependencies: { [name]: version },
				}),
				{ mode: 0o600 },
			);
			await run(
				"npm",
				[
					"install",
					"--ignore-scripts",
					"--include=optional",
					"--no-audit",
					"--no-fund",
					"--save-exact",
					"--cache",
					join(cacheDirectory, "npm"),
				],
				{ cwd, timeout: 120_000, maxBuffer: 1024 * 1024, signal },
			);
			const value: unknown = JSON.parse(await readFile(manifest, "utf8"));
			if (
				!value ||
				typeof value !== "object" ||
				!("name" in value) ||
				value.name !== name ||
				!("version" in value) ||
				value.version !== version
			)
				throw new Error(`Installed version does not match ${identity}`);
			await writeFile(completed, identity, { mode: 0o600 });
		}
		return manifest;
	} finally {
		lock.release();
	}
}
