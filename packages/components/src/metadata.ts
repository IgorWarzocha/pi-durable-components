import semver from "semver";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { isCapabilityObject } from "./capabilities.ts";
import type {
	ComponentCatalog,
	ComponentCompatibility,
	ComponentPackage,
} from "./contracts.ts";

const text = Type.String({ minLength: 1 });
const name = Type.String({
	pattern: "^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$",
});
const capability = Type.String({
	pattern: "^[a-z][a-z0-9.-]*\\.v[1-9][0-9]*$",
});
const closed = { additionalProperties: false };
const descriptor = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		kind: Type.Union(
			["extension", "provider", "service", "library"].map((v) =>
				Type.Literal(v),
			),
		),
		entry: Type.Optional(Type.Literal("./component")),
		runtimes: Type.Array(
			Type.Union([
				Type.Literal("node"),
				Type.Literal("workerd"),
				Type.Literal("browser"),
			]),
			{ minItems: 1, uniqueItems: true },
		),
		requires: Type.Array(capability, { uniqueItems: true }),
		permissions: Type.Array(
			Type.Union(
				[
					"filesystem",
					"process",
					"network",
					"audio",
					"browser",
					"models",
					"storage",
				].map((v) => Type.Literal(v)),
			),
			{ uniqueItems: true },
		),
		selectionGroup: Type.Optional(text),
	},
	closed,
);
const packageData = Type.Object(
	{
		name,
		version: text,
		description: Type.String(),
		peerDependencies: Type.Record(Type.String(), text),
		peerDependenciesMeta: Type.Record(
			Type.String(),
			Type.Object({ optional: Type.Optional(Type.Boolean()) }, closed),
		),
		durable: descriptor,
	},
	closed,
);
const catalogData = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		name: text,
		components: Type.Array(
			Type.Object(
				{ package: name, version: text, description: Type.String() },
				closed,
			),
		),
	},
	closed,
);

/** Parse only data. Unknown descriptor fields fail closed; standard npm fields remain allowed. */
export function parseComponentPackage(value: unknown): ComponentPackage {
	if (!isCapabilityObject(value))
		throw new Error("Expected npm package metadata");
	const selected = {
		name: value["name"],
		version: value["version"],
		description: value["description"] ?? "",
		peerDependencies: value["peerDependencies"] ?? {},
		peerDependenciesMeta: value["peerDependenciesMeta"] ?? {},
		durable: value["durable"],
	};
	if (!Check(packageData, selected))
		throw new Error("Invalid Durable component descriptor");
	if (semver.valid(selected.version) !== selected.version)
		throw new Error(
			"Component package version must be an exact semantic version",
		);
	const data = selected.durable;
	if (data.kind === "library") {
		if (data.entry !== undefined)
			throw new Error("Libraries do not declare runtime activation");
	} else {
		if (data.entry !== "./component")
			throw new Error("Runtime components require ./component");
		const exports = value["exports"];
		if (!isCapabilityObject(exports) || !Object.hasOwn(exports, data.entry))
			throw new Error(
				"Component activation entry is not a public package export",
			);
	}
	return selected;
}

export function parseComponentCatalog(value: unknown): ComponentCatalog {
	if (!Check(catalogData, value))
		throw new Error("Invalid Durable component catalogue");
	const seen = new Set<string>();
	for (const entry of value.components) {
		if (semver.valid(entry.version) !== entry.version)
			throw new Error(`Catalogue must pin an exact version: ${entry.package}`);
		if (seen.has(entry.package))
			throw new Error(`Duplicate catalogue package: ${entry.package}`);
		seen.add(entry.package);
	}
	return value;
}

export type ComponentCompatibilityResult =
	| { readonly status: "supported" }
	| { readonly status: "unsupported"; readonly reasons: readonly string[] };

export function checkComponentCompatibility(
	component: ComponentPackage,
	host: ComponentCompatibility,
): ComponentCompatibilityResult {
	const reasons: string[] = [];
	if (!component.durable.runtimes.includes(host.runtime))
		reasons.push(`Requires runtime ${component.durable.runtimes.join(" or ")}`);
	for (const id of component.durable.requires)
		if (!host.capabilities.has(id))
			reasons.push(`Missing host capability: ${id}`);
	for (const [name, range] of Object.entries(component.peerDependencies)) {
		const version = host.peers[name];
		if (!version && component.peerDependenciesMeta[name]?.optional) continue;
		if (!version || !semver.satisfies(version, range))
			reasons.push(`Requires ${name}@${range}; host has ${version ?? "none"}`);
	}
	return reasons.length
		? { status: "unsupported", reasons }
		: { status: "supported" };
}
