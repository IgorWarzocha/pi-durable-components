// Adapted from Pi Stuff 84bd5bce, MIT. See ../NOTICE.
import type { PortableState } from "./portable-state.ts";

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function assertPortableState(
	value: unknown,
): asserts value is PortableState {
	if (
		!record(value) ||
		value["version"] !== 1 ||
		!record(value["roots"]) ||
		!record(value["nodes"]) ||
		!record(value["bindings"]) ||
		!Array.isArray(value["pins"]) ||
		!value["pins"].every((item) => typeof item === "string") ||
		!Array.isArray(value["imports"]) ||
		!value["imports"].every((item) => typeof item === "string")
	)
		throw new Error("Invalid TS state; use notebook reset to start clean");
	const roots = value["roots"];
	const nodes = value["nodes"];
	const bindings = value["bindings"];
	const isValue = (item: unknown): boolean =>
		item === null ||
		item === undefined ||
		["string", "number", "boolean", "bigint"].includes(typeof item) ||
		(record(item) &&
			typeof item["ref"] === "string" &&
			Object.hasOwn(nodes, item["ref"]));
	for (const [name, binding] of Object.entries(value["bindings"])) {
		if (
			!/^[$_\p{ID_Start}][$_\u200c\u200d\p{ID_Continue}]*$/u.test(name) ||
			!record(binding) ||
			binding["name"] !== name ||
			![
				"let",
				"const",
				"function",
				"class",
				"enum",
				"namespace",
				"type",
				"import",
			].includes(String(binding["kind"])) ||
			typeof binding["declaration"] !== "string" ||
			(binding["source"] !== undefined && typeof binding["source"] !== "string")
		)
			throw new Error(`Invalid TS binding ${name}`);
		if (
			binding["references"] !== undefined &&
			(!Array.isArray(binding["references"]) ||
				!binding["references"].every((item) => typeof item === "string"))
		)
			throw new Error(`Invalid TS references for ${name}`);
		if (
			binding["checkpoint"] !== undefined &&
			(!record(binding["checkpoint"]) ||
				![
					binding["checkpoint"]["snapshot"],
					binding["checkpoint"]["restore"],
				].every(
					(helper) =>
						typeof helper === "string" && Object.hasOwn(bindings, helper),
				))
		)
			throw new Error(`Invalid TS checkpoint helpers for ${name}`);
		if (
			binding["hook"] !== undefined &&
			(!["startup", "tool_result"].includes(String(binding["hook"])) ||
				binding["kind"] !== "function" ||
				!value["pins"].includes(name))
		)
			throw new Error(
				`Invalid TS hook ${name}; hooks require pinned functions`,
			);
		if (
			binding["module"] !== undefined &&
			(!record(binding["module"]) ||
				typeof binding["module"]["specifier"] !== "string" ||
				typeof binding["module"]["imported"] !== "string")
		)
			throw new Error(`Invalid TS module recipe ${name}`);
	}
	if (!Object.values(roots).every(isValue))
		throw new Error("Invalid TS root reference");
	for (const node of Object.values(nodes)) {
		if (!record(node)) throw new Error("Invalid TS graph node");
		switch (node["kind"]) {
			case "checkpoint":
				if (
					![node["snapshot"], node["restore"]].every(
						(helper) =>
							typeof helper === "string" && Object.hasOwn(bindings, helper),
					) ||
					!isValue(node["data"])
				)
					throw new Error("Invalid TS checkpoint node");
				break;
			case "recipe":
				if (
					typeof node["name"] !== "string" ||
					!Object.hasOwn(value["bindings"], node["name"]) ||
					!record(node["properties"]) ||
					!Object.values(node["properties"]).every(isValue)
				)
					throw new Error("Invalid TS recipe");
				break;
			case "module":
				if (
					typeof node["specifier"] !== "string" ||
					typeof node["imported"] !== "string" ||
					(node["attributes"] !== undefined &&
						(!record(node["attributes"]) ||
							!Object.values(node["attributes"]).every(
								(item) => typeof item === "string",
							)))
				)
					throw new Error("Invalid TS module recipe");
				break;
			case "binary":
				if (!(node["bytes"] instanceof Uint8Array))
					throw new Error("Invalid TS binary value");
				break;
			case "date":
				if (typeof node["time"] !== "number")
					throw new Error("Invalid TS date");
				break;
			case "regexp":
				if (
					typeof node["source"] !== "string" ||
					typeof node["flags"] !== "string" ||
					typeof node["lastIndex"] !== "number"
				)
					throw new Error("Invalid TS regexp");
				break;
			case "view":
				if (
					typeof node["constructor"] !== "string" ||
					!isValue(node["buffer"]) ||
					!Number.isSafeInteger(node["byteOffset"]) ||
					!Number.isSafeInteger(node["length"])
				)
					throw new Error("Invalid TS typed array");
				break;
			case "object":
			case "array":
				if (
					!record(node["properties"]) ||
					!Object.values(node["properties"]).every(isValue) ||
					(node["kind"] === "array" &&
						(!Number.isSafeInteger(node["length"]) ||
							Number(node["length"]) < 0)) ||
					(node["kind"] === "object" &&
						typeof node["nullPrototype"] !== "boolean")
				)
					throw new Error("Invalid TS object node");
				break;
			case "map":
				if (
					!Array.isArray(node["entries"]) ||
					!node["entries"].every(
						(entry) =>
							Array.isArray(entry) &&
							entry.length === 2 &&
							entry.every(isValue),
					)
				)
					throw new Error("Invalid TS map");
				break;
			case "set":
				if (!Array.isArray(node["entries"]) || !node["entries"].every(isValue))
					throw new Error("Invalid TS set");
				break;
			default:
				throw new Error("Unknown TS graph node");
		}
	}
}
