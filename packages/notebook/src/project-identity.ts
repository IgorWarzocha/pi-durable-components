// Adapted from pi-codex-conversion at b2006db9def12c373ae48e70044d30f7d6b7e34f, MIT. See ../NOTICE.
import { existsSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";

export function resolveNotebookProject(cwd: string): string {
	let current = resolve(cwd);
	const root = parse(current).root;
	while (true) {
		if (existsSync(join(current, ".git"))) return current;
		if (current === root) return resolve(cwd);
		current = dirname(current);
	}
}
