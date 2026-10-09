#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
	existsSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = join(
	root,
	existsSync(join(root, "src/audio/bin")) ? "src/audio/bin" : "dist/audio/bin",
);
function filesBelow(relative) {
	const path = join(root, relative);
	if (!statSync(path).isDirectory()) return [relative];
	return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
		entry.name === "target" ? [] : filesBelow(`${relative}/${entry.name}`),
	);
}
const files = [
	"src/audio/rust",
	"scripts/build-audio-helper.mjs",
	"scripts/verify-audio-binaries.mjs",
	"scripts/plan-audio-binaries.mjs",
	"scripts/licenses",
]
	.flatMap(filesBelow)
	.sort();
const hash = createHash("sha256");
for (const relative of files)
	hash
		.update(relative)
		.update("\0")
		.update(readFileSync(join(root, relative)))
		.update("\0");
const inputs = hash.digest("hex");
const binaries = {};
const missing = [];
for (const platform of ["linux", "darwin", "win32"])
	for (const arch of ["x64", "arm64"])
		for (const name of [
			platform === "win32" ? "grok-audio.exe" : "grok-audio",
			"LICENSES.txt",
		]) {
			const relative = `${platform}-${arch}/${name}`;
			const path = join(bundle, relative);
			if (!existsSync(path) || !statSync(path).isFile() || !statSync(path).size)
				missing.push(relative);
			else
				binaries[relative] = createHash("sha256")
					.update(readFileSync(path))
					.digest("hex");
		}
// Preserve the carried upstream stamp unchanged. Portable local stamps use a distinct format/path.
const manifest = join(bundle, "portable-build-inputs.json");
if (process.argv.includes("--stamp")) {
	if (missing.length)
		throw new Error(`Cannot stamp incomplete bundle: ${missing.join(", ")}`);
	writeFileSync(
		manifest,
		`${JSON.stringify({ version: 1, format: "durable-grok-native-v1", inputs, binaries }, null, 2)}\n`,
	);
} else {
	const previous = existsSync(manifest)
		? JSON.parse(readFileSync(manifest, "utf8"))
		: undefined;
	const current =
		previous?.format === "durable-grok-native-v1" &&
		previous.inputs === inputs &&
		Object.entries(binaries).every(
			([relative, digest]) => previous.binaries?.[relative] === digest,
		);
	const rebuild = missing.length > 0 || !current;
	if (process.argv.includes("--check") && rebuild)
		throw new Error(
			"No current portable six-target build proof. The historical upstream stamp remains provenance, not a claim these adapted build scripts were executed",
		);
	console.log(
		JSON.stringify({
			rebuild,
			inputs,
			reason: missing.length
				? `Missing: ${missing.join(", ")}`
				: current
					? "Portable audio bundle fingerprint is current"
					: "Historical upstream bundle; no portable rebuild stamp",
		}),
	);
}
