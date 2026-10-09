import { cp, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const products = {
	"@howaboua/pi-durable-grok-voice": {
		roots: ["audio/bin", "lan/assets"],
		helper: "audio/bin",
		executable: "grok-audio",
		noticesPerTarget: true,
		notices: ["src/audio/PROVENANCE.md", "src/audio/rust/Cargo.lock"],
	},
	"@howaboua/pi-durable-gippity-voice": {
		roots: ["voice/bin"],
		helper: "voice/bin",
		executable: "pi-codex-voice",
		noticesPerTarget: false,
		notices: [
			"src/voice/rust/Cargo.lock",
			"src/voice/rust/VENDORED.md",
			"src/voice/rust/vendor/openai-codex/LICENSE",
			"src/voice/rust/vendor/openai-codex/NOTICE",
		],
	},
};

async function assetFiles(directory, relative) {
	const files = [];
	for (const entry of await readdir(join(directory, relative), {
		withFileTypes: true,
	})) {
		const path = `${relative}/${entry.name}`;
		if (entry.isDirectory()) files.push(...(await assetFiles(directory, path)));
		else if (entry.isFile()) files.push(path);
		else throw new Error(`Voice assets must be regular files: ${path}`);
	}
	return files;
}

export async function buildVoiceAssets(directory, name) {
	const product = products[name];
	if (!product) return;
	for (const root of product.roots) {
		await assetFiles(directory, `src/${root}`);
		await cp(join(directory, "src", root), join(directory, "dist", root), {
			recursive: true,
		});
	}
}

/** Check distribution bytes and notices without opening devices or running foreign binaries. */
export async function checkVoiceAssets(directory, name, paths) {
	const product = products[name];
	if (!product) return;
	const required = [...product.notices];
	for (const platform of ["linux", "darwin", "win32"])
		for (const arch of ["x64", "arm64"]) {
			const target = `${platform}-${arch}`;
			const file = product.executable + (platform === "win32" ? ".exe" : "");
			required.push(`dist/${product.helper}/${target}/${file}`);
			if (product.noticesPerTarget)
				required.push(`dist/${product.helper}/${target}/LICENSES.txt`);
		}
	for (const path of required) {
		if (!paths.has(path) || (await stat(join(directory, path))).size === 0)
			throw new Error(`${name} tarball is missing a nonempty ${path}`);
	}
	for (const root of product.roots)
		for (const source of await assetFiles(directory, `src/${root}`)) {
			const shipped = source.replace(/^src\//, "dist/");
			if (paths.has(source))
				throw new Error(`${name} ships duplicate source asset ${source}`);
			if (
				!paths.has(shipped) ||
				!(await readFile(join(directory, source))).equals(
					await readFile(join(directory, shipped)),
				)
			)
				throw new Error(`${name} changed or omitted voice asset ${shipped}`);
		}
}
