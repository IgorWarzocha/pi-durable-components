#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = join(
	root,
	existsSync(join(root, "src/audio/bin")) ? "src/audio/bin" : "dist/audio/bin",
);
const portable = join(bundle, "portable-build-inputs.json");
const manifest = JSON.parse(
	readFileSync(
		existsSync(portable) ? portable : join(bundle, "build-inputs.json"),
		"utf8",
	),
);
const missing = [];
for (const platform of ["linux", "darwin", "win32"])
	for (const arch of ["x64", "arm64"]) {
		const target = `${platform}-${arch}`;
		for (const name of [
			platform === "win32" ? "grok-audio.exe" : "grok-audio",
			"LICENSES.txt",
		]) {
			const relative = `${target}/${name}`;
			const path = join(bundle, relative);
			if (
				!existsSync(path) ||
				!statSync(path).isFile() ||
				statSync(path).size === 0
			)
				missing.push(relative);
			else if (
				createHash("sha256").update(readFileSync(path)).digest("hex") !==
				manifest.binaries?.[relative]
			)
				throw new Error(
					`Grok audio artifact does not match its recorded build: ${relative}`,
				);
		}
	}
if (missing.length)
	throw new Error(`Missing Grok audio artifacts: ${missing.join(", ")}`);
console.log(
	"All six Grok audio binaries and notices match their recorded SHA256 digests; this is artifact integrity, not device acceptance or a rebuilt-source proof",
);
