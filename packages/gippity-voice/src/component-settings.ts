import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { GippitySettingsStore } from "./host.ts";

/** Pure construction; the original controller decides when to load/save. */
export function componentSettings(
	directory: string,
	initial: unknown,
): GippitySettingsStore {
	if (!isAbsolute(directory))
		throw new Error("Voice state requires an authorised absolute directory");
	const file = join(directory, "settings.json");
	return {
		async read() {
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
		async write(config) {
			await mkdir(directory, { recursive: true });
			await writeFile(`${file}.tmp`, JSON.stringify(config), { mode: 0o600 });
			await rename(`${file}.tmp`, file);
		},
	};
}
