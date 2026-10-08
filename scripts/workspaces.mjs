import { spawn } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const command = process.argv[2];
if (!["test", "build", "pack", "pack:dry"].includes(command))
	throw new Error("Expected test, build, pack or pack:dry");
const destination = command === "pack" ? process.argv[3] : undefined;
if (command === "pack" && !destination)
	throw new Error("pack requires an output directory");

async function filesBelow(directory, matches) {
	const found = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === "dist") continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) found.push(...(await filesBelow(path, matches)));
		else if (entry.isFile() && matches(entry.name)) found.push(path);
	}
	return found;
}

async function run(args, executable = process.execPath) {
	const child = spawn(executable, args, { cwd: root, stdio: "inherit" });
	await new Promise((done, fail) => {
		child.once("error", fail);
		child.once("exit", (code, signal) => {
			if (code === 0) done();
			else fail(new Error(`${args.join(" ")} exited with ${signal ?? code}`));
		});
	});
}

const workspaces = new Map();
for (const entry of await readdir(join(root, "packages"), {
	withFileTypes: true,
})) {
	if (!entry.isDirectory()) continue;
	const directory = join(root, "packages", entry.name);
	let source;
	try {
		source = await readFile(join(directory, "package.json"), "utf8");
	} catch (error) {
		if (error.code === "ENOENT") continue;
		throw error;
	}
	const manifest = JSON.parse(source);
	workspaces.set(manifest.name, { directory, manifest });
}
if (workspaces.size === 0) throw new Error("No component packages found");
for (const { manifest } of workspaces.values()) {
	for (const dependency of Object.keys({
		...manifest.dependencies,
		...manifest.peerDependencies,
	})) {
		if (
			workspaces.has(dependency) &&
			!(
				manifest.name === "@howaboua/pi-durable-ui" &&
				dependency === "@howaboua/pi-durable-git"
			)
		)
			throw new Error(
				`${manifest.name} must not require another component: ${dependency}`,
			);
	}
}

if (command === "test") {
	const tests = await filesBelow(join(root, "packages"), (name) =>
		/\.test\.(ts|mjs)$/.test(name),
	);
	try {
		tests.push(
			...(await filesBelow(join(root, "test"), (name) =>
				/\.test\.(ts|mjs)$/.test(name),
			)),
		);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	if (tests.length === 0) throw new Error("No contract tests found");
	await run(["--experimental-strip-types", "--test", ...tests.sort()]);
} else if (command === "build") {
	// Git contracts must be built before the UI declarations consume their public export.
	for (const { directory, manifest } of [...workspaces.values()].sort((a, b) =>
		a.manifest.name.localeCompare(b.manifest.name),
	)) {
		await rm(join(directory, "dist"), {
			recursive: true,
			force: true,
		});
		await run([
			join(root, "node_modules/typescript/bin/tsc"),
			"-p",
			join(directory, "tsconfig.json"),
		]);
		// Bundle only owned source. The host must supply one shared Durable runtime.
		const entries = Object.values(manifest.exports).filter(
			(entry) => typeof entry === "object" && entry.import,
		);
		for (const entry of entries)
			await run(
				[
					"build",
					join(
						directory,
						entry.import
							.replace("./dist/", "src/")
							.replace(
								/\.js$/,
								manifest.name === "@howaboua/pi-durable-ui" &&
									entry.import.includes("/react/")
									? ".tsx"
									: ".ts",
							),
					),
					[
						"@howaboua/pi-durable-worker-code",
						"@howaboua/pi-durable-ui",
					].includes(manifest.name) || entry.import === "./dist/contracts.js"
						? "--target=browser"
						: "--target=node",
					"--format=esm",
					"--packages=external",
					`--outfile=${join(directory, entry.import)}`,
				],
				"bun",
			);
		if (manifest.name === "@howaboua/pi-durable-worker-code") {
			const dependency = createRequire(join(directory, "package.json"));
			await copyFile(
				dependency.resolve("@jitl/quickjs-wasmfile-release-sync/wasm"),
				join(directory, "dist/quickjs.wasm"),
			);
			await copyFile(
				join(
					dirname(
						dependency.resolve(
							"@jitl/quickjs-wasmfile-release-sync/package.json",
						),
					),
					"LICENSE",
				),
				join(directory, "dist/QUICKJS-LICENSE"),
			);
		}
		if (manifest.name === "@howaboua/pi-durable-browser") {
			await run(
				[
					"build",
					join(directory, "src/remote-worker.ts"),
					"--target=node",
					"--format=esm",
					`--outfile=${join(directory, "dist/remote-worker.js")}`,
					"--banner=// @howaboua/pi-durable-browser managed worker",
				],
				"bun",
			);
		}
	}
} else {
	if (destination) await mkdir(resolve(root, destination), { recursive: true });
	for (const { directory, manifest } of workspaces.values()) {
		const child = spawn(
			"npm",
			[
				"pack",
				"--json",
				"--ignore-scripts",
				...(destination
					? ["--pack-destination", resolve(root, destination)]
					: ["--dry-run"]),
			],
			{
				cwd: directory,
				stdio: ["ignore", "pipe", "inherit"],
			},
		);
		let output = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			output += chunk;
		});
		await new Promise((done, fail) => {
			child.once("error", fail);
			child.once("exit", (code, signal) =>
				code === 0
					? done()
					: fail(
							new Error(`Pack ${manifest.name} exited with ${signal ?? code}`),
						),
			);
		});
		const [pack] = JSON.parse(output);
		const paths = new Set(pack.files.map((file) => file.path));
		for (const required of [
			"README.md",
			"LICENSE",
			"NOTICE",
			manifest.main,
			manifest.types,
			...Object.values(manifest.exports).flatMap((entry) =>
				typeof entry === "object"
					? [entry.import, entry.types].filter(Boolean)
					: [],
			),
			...(manifest.name === "@howaboua/pi-durable-worker-code"
				? ["dist/quickjs.wasm", "dist/QUICKJS-LICENSE"]
				: []),
		]) {
			if (!paths.has(required.replace(/^\.\//, "")))
				throw new Error(`${manifest.name} tarball is missing ${required}`);
		}
		if (
			[...paths].some((path) =>
				/(^|\/)(test|tests|node_modules|\.pi)\//.test(path),
			)
		) {
			throw new Error(
				`${manifest.name} tarball includes development or runtime state`,
			);
		}
		const expectedJavaScript = new Set(
			Object.values(manifest.exports).flatMap((entry) =>
				typeof entry === "object" && entry.import
					? [entry.import.replace(/^\.\//, "")]
					: [],
			),
		);
		if (manifest.name === "@howaboua/pi-durable-worker-code") {
			const dependency = createRequire(join(directory, "package.json"));
			const shipped = await readFile(join(directory, "dist/quickjs.wasm"));
			const upstream = await readFile(
				dependency.resolve("@jitl/quickjs-wasmfile-release-sync/wasm"),
			);
			if (!shipped.equals(upstream))
				throw new Error("Worker Code must ship the exact pinned QuickJS WASM");
		}
		if (manifest.name === "@howaboua/pi-durable-browser") {
			expectedJavaScript.add("dist/remote-worker.js");
			const worker = await readFile(
				join(directory, "dist/remote-worker.js"),
				"utf8",
			);
			if (
				!worker
					.slice(0, 512)
					.includes("// @howaboua/pi-durable-browser managed worker")
			)
				throw new Error(
					"Browser worker is missing its deployment ownership marker",
				);
		}
		const actualJavaScript = [...paths].filter((path) => path.endsWith(".js"));
		if (
			actualJavaScript.length !== expectedJavaScript.size ||
			actualJavaScript.some((path) => !expectedJavaScript.has(path))
		)
			throw new Error(
				`${manifest.name} must ship self-contained JavaScript entry points`,
			);
		await import(join(directory, manifest.main));
		console.log(
			`${manifest.name}: ${pack.files.length} packed files, public entry imports successfully`,
		);
	}
}
