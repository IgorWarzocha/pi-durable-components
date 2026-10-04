import { spawn } from "node:child_process";
import { readdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const command = process.argv[2];
if (!["test", "build", "pack:dry"].includes(command))
	throw new Error("Expected test, build or pack:dry");

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

async function run(args) {
	const child = spawn(process.execPath, args, { cwd: root, stdio: "inherit" });
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

if (command === "test") {
	const tests = await filesBelow(join(root, "packages"), (name) =>
		name.endsWith(".test.ts"),
	);
	try {
		tests.push(
			...(await filesBelow(join(root, "test"), (name) =>
				name.endsWith(".test.ts"),
			)),
		);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	if (tests.length === 0) throw new Error("No contract tests found");
	await run(["--experimental-strip-types", "--test", ...tests.sort()]);
} else if (command === "build") {
	const built = new Set();
	const visiting = new Set();
	async function build(name) {
		if (built.has(name)) return;
		if (visiting.has(name))
			throw new Error(`Workspace dependency cycle at ${name}`);
		const workspace = workspaces.get(name);
		visiting.add(name);
		const dependencies = {
			...workspace.manifest.dependencies,
			...workspace.manifest.peerDependencies,
		};
		for (const dependency of Object.keys(dependencies)) {
			if (workspaces.has(dependency)) await build(dependency);
		}
		await rm(join(workspace.directory, "dist"), {
			recursive: true,
			force: true,
		});
		await run([
			join(root, "node_modules/typescript/bin/tsc"),
			"-p",
			join(workspace.directory, "tsconfig.json"),
		]);
		if (name === "@howaboua/pi-durable-browser") {
			const child = spawn(
				"bun",
				[
					"build",
					join(workspace.directory, "src/remote-worker.ts"),
					"--target=node",
					"--format=esm",
					`--outfile=${join(workspace.directory, "dist/remote-worker.js")}`,
					"--banner=// @howaboua/pi-durable-browser managed worker",
				],
				{ cwd: root, stdio: "inherit" },
			);
			await new Promise((done, fail) => {
				child.once("error", fail);
				child.once("exit", (code, signal) =>
					code === 0
						? done()
						: fail(
								new Error(
									`Browser worker bundle exited with ${signal ?? code}`,
								),
							),
				);
			});
		}
		visiting.delete(name);
		built.add(name);
	}
	if (workspaces.size === 0) throw new Error("No component packages found");
	for (const name of workspaces.keys()) await build(name);
} else {
	for (const { directory, manifest } of workspaces.values()) {
		const child = spawn(
			"npm",
			["pack", "--dry-run", "--json", "--ignore-scripts"],
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
		await import(join(directory, manifest.main));
		console.log(
			`${manifest.name}: ${pack.files.length} packed files, public entry imports successfully`,
		);
	}
}
