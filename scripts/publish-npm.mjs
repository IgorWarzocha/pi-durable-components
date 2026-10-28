import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

// Publish the exact GitHub release bytes. A rerun may resume only identical versions.
const [directory, tag, mode = "validate"] = process.argv.slice(2);
if (!directory || !/^v\d+\.\d+\.\d+$/.test(tag ?? ""))
	throw new Error(
		"Usage: publish-npm.mjs RELEASE_DIRECTORY vX.Y.Z [validate|bootstrap|trusted]",
	);
if (!["validate", "bootstrap", "trusted"].includes(mode))
	throw new Error("Choose validate, bootstrap or trusted");
const version = tag.slice(1);
const root = resolve(directory);
const entries = JSON.parse(
	await readFile(join(root, "artifacts.json"), "utf8"),
);
if (!Array.isArray(entries)) throw new Error("Invalid release manifest");
const expected = new Map();
for (const dir of await readdir("packages")) {
	try {
		const manifest = JSON.parse(
			await readFile(join("packages", dir, "package.json"), "utf8"),
		);
		if (manifest.name) expected.set(manifest.name, dir);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
}
if (entries.length !== expected.size)
	throw new Error("Release package count does not match this repository");
const seen = new Set();
const ready = [];
for (const entry of entries) {
	if (
		!entry ||
		typeof entry.name !== "string" ||
		!expected.has(entry.name) ||
		seen.has(entry.name) ||
		entry.version !== version ||
		typeof entry.filename !== "string" ||
		basename(entry.filename) !== entry.filename ||
		!/^[a-z0-9.-]+\.tgz$/.test(entry.filename) ||
		!/^[a-f0-9]{64}$/.test(entry.sha256)
	)
		throw new Error("Invalid or duplicate release package entry");
	seen.add(entry.name);
	const file = join(root, entry.filename);
	const data = await readFile(file);
	if (createHash("sha256").update(data).digest("hex") !== entry.sha256)
		throw new Error(`Release checksum mismatch: ${entry.name}`);
	const manifest = JSON.parse(
		execFileSync("tar", ["-xOzf", file, "package/package.json"], {
			encoding: "utf8",
		}),
	);
	if (
		manifest.name !== entry.name ||
		manifest.version !== version ||
		manifest.private === true ||
		manifest.publishConfig?.access !== "public"
	)
		throw new Error(`Release manifest mismatch: ${entry.name}`);
	if (
		mode === "trusted" &&
		(manifest.repository?.url !==
			"git+https://github.com/IgorWarzocha/pi-durable-components.git" ||
			manifest.repository?.directory !== `packages/${expected.get(entry.name)}`)
	)
		throw new Error(
			`Trusted publishing requires matching repository metadata in ${entry.name}; publish a newly built release`,
		);
	ready.push({
		name: entry.name,
		file,
		integrity: `sha512-${createHash("sha512").update(data).digest("base64")}`,
	});
}
if (mode === "validate") {
	console.log(`Verified ${ready.length} release archives for ${tag}`);
	process.exit(0);
}
// Resolve the entire registry state before publishing any package.
for (const item of ready) {
	const response = await fetch(
		`https://registry.npmjs.org/${encodeURIComponent(item.name)}`,
	);
	if (response.status === 404) continue;
	if (!response.ok)
		throw new Error(
			`Registry lookup failed for ${item.name}: HTTP ${response.status}`,
		);
	const metadata = await response.json();
	const published = metadata.versions?.[version];
	if (published && published.dist?.integrity !== item.integrity)
		throw new Error(
			`${item.name}@${version} already exists with different bytes`,
		);
	item.published = Boolean(published);
}
for (const item of ready) {
	if (item.published) {
		console.log(
			`Already published with matching integrity: ${item.name}@${version}`,
		);
		continue;
	}
	console.log(`Publishing ${item.name}@${version}`);
	execFileSync(
		"npm",
		["publish", item.file, "--access", "public", "--ignore-scripts"],
		{ stdio: "inherit" },
	);
}
