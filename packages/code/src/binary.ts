import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { codeModeHostBinaryName, HOST_RELEASE } from "./host-assets.ts";
import { installCodeModeHost } from "./install-host.ts";

export interface HostOptions {
	/** Explicit supported standalone host. Overrides automatic provisioning. */
	hostPath?: string;
	cacheDirectory?: string;
}

export async function ensureHost(
	options: HostOptions,
	signal?: AbortSignal,
): Promise<string> {
	signal?.throwIfAborted();
	if (options.hostPath !== undefined) {
		if (!existsSync(options.hostPath))
			throw new Error(`Code host does not exist: ${options.hostPath}`);
		return options.hostPath;
	}
	const destination = join(
		options.cacheDirectory ?? join(homedir(), ".cache", "pi-durable-code"),
		HOST_RELEASE,
		`${process.platform}-${process.arch}`,
		codeModeHostBinaryName(process.platform),
	);
	await installCodeModeHost({
		destination,
		platform: process.platform,
		arch: process.arch,
		...(signal ? { signal } : {}),
	});
	signal?.throwIfAborted();
	return destination;
}
