import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import {
	type BrowserRouteConfig,
	normalizeBrowserRouteConfig,
} from "./config.ts";

/** Host-selected persistence; writes must replace the complete value atomically. */
export interface BrowserRouteConfigStore {
	readonly id: string;
	read(): Promise<string | undefined>;
	write(text: string | undefined): Promise<void>;
}

/** A native path is used only when the host explicitly constructs this store. */
export function createBrowserRouteConfigFileStore(
	path: string,
): BrowserRouteConfigStore {
	if (!isAbsolute(path) || !basename(path))
		throw new Error("Browser route config path must name an absolute file");
	const directory = dirname(path);
	return {
		id: path,
		async read() {
			try {
				return await readFile(path, "utf8");
			} catch (error) {
				if (isCode(error, "ENOENT")) return undefined;
				throw error;
			}
		},
		async write(text) {
			if (text === undefined) {
				await rm(path, { force: true });
				return;
			}
			await mkdir(directory, { recursive: true });
			const temporary = join(
				directory,
				`.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
			);
			try {
				await writeFile(temporary, text, {
					encoding: "utf8",
					flag: "wx",
					mode: 0o600,
				});
				await rename(temporary, path);
			} finally {
				await rm(temporary, { force: true });
			}
		},
	};
}

export async function readBrowserRouteConfig(
	store: BrowserRouteConfigStore,
): Promise<BrowserRouteConfig> {
	const text = await store.read();
	if (text === undefined) return normalizeBrowserRouteConfig({});
	try {
		return normalizeBrowserRouteConfig(JSON.parse(text));
	} catch (error) {
		throw new Error(
			`Invalid browser route config in ${store.id}: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
}

export async function writeBrowserRouteConfig(
	store: BrowserRouteConfigStore,
	config: unknown,
): Promise<BrowserRouteConfig> {
	const normalized = normalizeBrowserRouteConfig(config);
	const text =
		normalized.hosts.length || normalized.voiceOnly
			? `${JSON.stringify(normalized, null, 2)}\n`
			: undefined;
	await store.write(text);
	return normalized;
}

function isCode(error: unknown, code: string): boolean {
	return (
		!!error &&
		typeof error === "object" &&
		"code" in error &&
		error.code === code
	);
}
