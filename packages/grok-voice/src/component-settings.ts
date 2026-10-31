import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { GrokRealtimeConfig } from "./config.ts";

/** Pure construction; the original controller owns settings operation ordering. */
export function componentSettings(directory: string, initial: unknown) {
	if (!isAbsolute(directory))
		throw new Error("Voice state requires an authorised absolute directory");
	const file = join(directory, "settings.json");
	return {
		async load(): Promise<unknown> {
			try {
				return JSON.parse(await readFile(file, "utf8"));
			} catch (error) {
				if (
					error instanceof Error &&
					"code" in error &&
					error.code === "ENOENT"
				)
					return initial;
				throw error;
			}
		},
		async save(config: GrokRealtimeConfig) {
			await mkdir(directory, { recursive: true });
			await writeFile(`${file}.tmp`, JSON.stringify(config), { mode: 0o600 });
			await rename(`${file}.tmp`, file);
		},
	};
}
