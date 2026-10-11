import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rmdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
	SettingsError,
	type SettingsStorage,
	type SettingsWrite,
	type StoredSettings,
	settingsObject,
} from "../../../internal/settings/index.ts";

export interface NodeSettingsStorageOptions {
	id: string;
	/** Absolute directory already naming .pi/durable-components; no discovery. */
	globalRoot: string;
	projectRoot?: string;
}

function hasCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

async function readBytes(
	path: string,
	maxBytes: number,
): Promise<Buffer | null> {
	let handle;
	try {
		handle = await open(
			path,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
	} catch (error) {
		if (hasCode(error, "ENOENT")) return null;
		throw error;
	}
	try {
		const stat = await handle.stat();
		if (!stat.isFile())
			throw new SettingsError(
				"invalid",
				`Settings file is not a regular file: ${path}`,
			);
		if (stat.size > maxBytes)
			throw new SettingsError(
				"invalid",
				`Settings file exceeds ${maxBytes} bytes: ${path}`,
			);
		const bytes = Buffer.alloc(maxBytes + 1);
		let length = 0;
		while (length < bytes.length) {
			const result = await handle.read(
				bytes,
				length,
				bytes.length - length,
				null,
			);
			if (result.bytesRead === 0) break;
			length += result.bytesRead;
		}
		if (length > maxBytes)
			throw new SettingsError(
				"invalid",
				`Settings file exceeds ${maxBytes} bytes: ${path}`,
			);
		return bytes.subarray(0, length);
	} finally {
		await handle.close();
	}
}

function parseOverride(bytes: Buffer | null, path: string) {
	if (bytes === null) return null;
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
		return settingsObject(value);
	} catch (error) {
		throw new SettingsError(
			"invalid",
			`Invalid settings JSON: ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function revision(global: Buffer | null, project: Buffer | null): string {
	const hash = createHash("sha256");
	for (const bytes of [global, project]) {
		hash.update(bytes === null ? "missing;" : `${bytes.length}:`);
		if (bytes !== null) hash.update(bytes);
	}
	return hash.digest("hex");
}

async function atomicReplace(
	path: string,
	bytes: Buffer | null,
): Promise<void> {
	if (bytes === null) {
		try {
			await unlink(path);
		} catch (error) {
			if (!hasCode(error, "ENOENT")) throw error;
		}
	} else {
		const temporary = `${path}.${randomUUID()}.tmp`;
		const handle = await open(temporary, "wx", 0o600);
		try {
			try {
				await handle.writeFile(bytes);
				await handle.sync();
			} finally {
				await handle.close();
			}
			await rename(temporary, path);
		} finally {
			await unlink(temporary).catch((error: unknown) => {
				if (!hasCode(error, "ENOENT")) throw error;
			});
		}
	}
	try {
		const directory = await open(dirname(path), constants.O_RDONLY);
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	} catch (cause) {
		throw new Error(
			`Settings were replaced but directory synchronization failed: ${path}. Reload before retrying; crash durability is uncertain.`,
			{ cause },
		);
	}
}

/**
 * Cooperative per-component locks serialize reads and CAS writes across processes.
 * Roots are trusted host directories, created on first use. Locks are never stolen:
 * a crashed owner requires operator recovery. Arbitrary editors do not take these
 * locks and are not covered by the compare-and-swap guarantee.
 */
export function createNodeSettingsStorage(
	options: NodeSettingsStorageOptions,
): SettingsStorage {
	if (
		options.id.length > 128 ||
		!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(options.id)
	)
		throw new SettingsError("invalid", "Invalid settings component id");
	if (
		!isAbsolute(options.globalRoot) ||
		(options.projectRoot !== undefined && !isAbsolute(options.projectRoot))
	) {
		throw new SettingsError(
			"invalid",
			"Settings roots must be absolute directories",
		);
	}
	const roots = {
		global: resolve(options.globalRoot),
		project:
			options.projectRoot === undefined ? null : resolve(options.projectRoot),
	};
	if (roots.global === roots.project)
		throw new SettingsError(
			"invalid",
			"Global and project settings roots must differ",
		);
	const paths = {
		global: join(roots.global, `${options.id}.json`),
		project:
			roots.project === null ? null : join(roots.project, `${options.id}.json`),
	};
	const maxBytes = 256 * 1024;
	const lockTimeoutMs = 5000;
	const lockPaths = [
		paths.global,
		...(paths.project === null ? [] : [paths.project]),
	]
		.sort()
		.map((path) => `${path}.lock`);

	async function locked<T>(
		operation: () => Promise<T>,
		signal?: AbortSignal,
	): Promise<T> {
		const acquired: string[] = [];
		const deadline = performance.now() + lockTimeoutMs;
		try {
			for (const root of [roots.global, roots.project]) {
				signal?.throwIfAborted();
				if (root !== null) await mkdir(root, { recursive: true, mode: 0o700 });
			}
			for (const lockPath of lockPaths) {
				while (true) {
					signal?.throwIfAborted();
					try {
						await mkdir(lockPath, { mode: 0o700 });
						acquired.push(lockPath);
						break;
					} catch (error) {
						if (!hasCode(error, "EEXIST")) throw error;
						const remaining = deadline - performance.now();
						if (remaining <= 0)
							throw new SettingsError(
								"busy",
								`Settings lock timed out: ${lockPath}. If its owner crashed, remove the lock directory only after confirming no writer is running.`,
							);
						await delay(Math.min(25, remaining), undefined, { signal });
					}
				}
			}
			signal?.throwIfAborted();
			return await operation();
		} finally {
			await Promise.all(acquired.reverse().map((lockPath) => rmdir(lockPath)));
		}
	}

	async function load() {
		const global = await readBytes(paths.global, maxBytes);
		const project =
			paths.project === null ? null : await readBytes(paths.project, maxBytes);
		const stored: StoredSettings = {
			revision: revision(global, project),
			overrides: {
				global: parseOverride(global, paths.global),
				project:
					paths.project === null ? null : parseOverride(project, paths.project),
			},
			sources: { ...paths },
		};
		return { global, project, stored };
	}

	return {
		id: options.id,
		read: (signal?: AbortSignal): Promise<StoredSettings> =>
			locked(async () => (await load()).stored, signal),
		replaceOverride: (
			request: SettingsWrite,
			signal?: AbortSignal,
		): Promise<StoredSettings> => {
			if (request.scope !== "global" && request.scope !== "project")
				throw new SettingsError("invalid", "Unsupported settings scope");
			const path = paths[request.scope];
			if (path === null)
				throw new SettingsError(
					"unavailable",
					"Project settings scope is unavailable without projectRoot",
				);
			const scope = request.scope;
			const expectedRevision = request.expectedRevision;
			const bytes =
				request.value === null
					? null
					: Buffer.from(
							`${JSON.stringify(settingsObject(request.value), null, 2)}\n`,
						);
			if (bytes !== null && bytes.length > maxBytes)
				throw new SettingsError(
					"invalid",
					`Settings override exceeds ${maxBytes} bytes`,
				);
			return locked(async () => {
				const current = await load();
				if (current.stored.revision !== expectedRevision)
					throw new SettingsError(
						"conflict",
						"Settings changed since the expected revision; reload before saving.",
					);
				signal?.throwIfAborted();
				// Once commit begins, cancellation cannot safely imply that nothing changed.
				await atomicReplace(path, bytes);
				const global = scope === "global" ? bytes : current.global;
				const project = scope === "project" ? bytes : current.project;
				return {
					revision: revision(global, project),
					overrides: {
						global: parseOverride(global, paths.global),
						project:
							paths.project === null
								? null
								: parseOverride(project, paths.project),
					},
					sources: { ...paths },
				};
			}, signal);
		},
	};
}
