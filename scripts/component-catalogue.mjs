import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	parseComponentCatalog,
	parseComponentPackage,
} from "../packages/components/dist/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const components = [];
for (const entry of await readdir(join(root, "packages"), {
	withFileTypes: true,
})) {
	if (!entry.isDirectory()) continue;
	let metadata;
	try {
		metadata = JSON.parse(
			await readFile(
				join(root, "packages", entry.name, "package.json"),
				"utf8",
			),
		);
	} catch (error) {
		if (error.code === "ENOENT") continue;
		throw error;
	}
	const component = parseComponentPackage(metadata);
	components.push({
		package: component.name,
		version: component.version,
		description: component.description,
	});
}
components.sort((a, b) => a.package.localeCompare(b.package));
const catalogue = parseComponentCatalog({
	schemaVersion: 1,
	name: "Howaboua Durable Components",
	components,
});
const data = `${JSON.stringify(catalogue, null, "\t")}\n`;
for (const file of ["marketplace.json", "packages/components/catalogue.json"]) {
	if (process.argv.includes("--check")) {
		if ((await readFile(join(root, file), "utf8")) !== data)
			throw new Error(`${file} is stale; run bun run catalogue`);
	} else await writeFile(join(root, file), data);
}
console.log(
	`${process.argv.includes("--check") ? "Checked" : "Wrote"} catalogue for ${components.length} exact component versions`,
);
