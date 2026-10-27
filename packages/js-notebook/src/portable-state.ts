// Adapted from Pi Stuff 84bd5bce, MIT. See ../NOTICE.
import { randomUUID } from "node:crypto";
import { deserialize, serialize } from "node:v8";

export type PortableValue =
	| null
	| undefined
	| string
	| number
	| boolean
	| bigint
	| { ref: string };
type PortableNode =
	| {
			kind: "object";
			nullPrototype: boolean;
			properties: Record<string, PortableValue>;
	  }
	| { kind: "array"; length: number; properties: Record<string, PortableValue> }
	| { kind: "map"; entries: [PortableValue, PortableValue][] }
	| { kind: "set"; entries: PortableValue[] }
	| { kind: "binary"; bytes: Uint8Array }
	| { kind: "date"; time: number }
	| { kind: "regexp"; source: string; flags: string; lastIndex: number }
	| {
			kind: "view";
			constructor: string;
			buffer: PortableValue;
			byteOffset: number;
			length: number;
	  }
	| { kind: "recipe"; name: string; properties: Record<string, PortableValue> }
	| {
			kind: "checkpoint";
			snapshot: string;
			restore: string;
			data: PortableValue;
	  }
	| {
			kind: "module";
			specifier: string;
			imported: string;
			attributes?: Record<string, string> | undefined;
	  };

interface BindingRecipe {
	name: string;
	kind: string;
	declaration: string;
	source?: string | undefined;
	references?: string[] | undefined;
	module?:
		| {
				specifier: string;
				imported: string;
				attributes?: Record<string, string> | undefined;
		  }
		| undefined;
	hook?: "startup" | "tool_result" | undefined;
	checkpoint?: { snapshot: string; restore: string } | undefined;
}

export interface PortableState {
	version: 1;
	roots: Record<string, PortableValue>;
	nodes: Record<string, PortableNode>;
	bindings: Record<string, BindingRecipe>;
	pins: string[];
	imports: string[];
}

export function emptyState(): PortableState {
	return {
		version: 1,
		roots: {},
		nodes: {},
		bindings: {},
		pins: [],
		imports: [],
	};
}

/** Profiles are loaded by value: their graph IDs must not alias an existing session graph. */
export function forkPortableState(original: PortableState): PortableState {
	return remapPortableState(original, () => randomUUID());
}

function remapPortableState(
	original: PortableState,
	identity: (index: number) => string,
): PortableState {
	const state: PortableState = deserialize(serialize(original));
	const ids = new Map(
		Object.keys(state.nodes).map((id, index) => [id, identity(index)]),
	);
	const remap = (value: PortableValue): PortableValue =>
		value !== null && typeof value === "object"
			? { ref: ids.get(value.ref) ?? value.ref }
			: value;
	const properties = (
		values: Record<string, PortableValue>,
	): Record<string, PortableValue> =>
		Object.fromEntries(
			Object.entries(values).map(([name, value]) => [name, remap(value)]),
		);
	state.roots = properties(state.roots);
	state.nodes = Object.fromEntries(
		Object.entries(state.nodes).map(([id, node]) => {
			switch (node.kind) {
				case "object":
				case "array":
				case "recipe":
					node.properties = properties(node.properties);
					break;
				case "map":
					node.entries = node.entries.map(([key, value]) => [
						remap(key),
						remap(value),
					]);
					break;
				case "set":
					node.entries = node.entries.map(remap);
					break;
				case "view":
					node.buffer = remap(node.buffer);
					break;
				case "checkpoint":
					node.data = remap(node.data);
					break;
			}
			return [ids.get(id) ?? id, node];
		}),
	);
	return state;
}

export function compactState(state: PortableState): PortableState {
	const reachable = new Set<string>();
	const visit = (value: PortableValue): void => {
		if (value === null || typeof value !== "object" || reachable.has(value.ref))
			return;
		reachable.add(value.ref);
		const node = state.nodes[value.ref];
		if (!node) throw new Error(`Missing portable object ${value.ref}`);
		if (
			node.kind === "object" ||
			node.kind === "array" ||
			node.kind === "recipe"
		)
			Object.values(node.properties).forEach(visit);
		else if (node.kind === "map")
			node.entries.forEach(([key, item]) => {
				visit(key);
				visit(item);
			});
		else if (node.kind === "set") node.entries.forEach(visit);
		else if (node.kind === "view") visit(node.buffer);
		else if (node.kind === "checkpoint") visit(node.data);
	};
	Object.values(state.roots).forEach(visit);
	state.nodes = Object.fromEntries(
		Object.entries(state.nodes).filter(([id]) => reachable.has(id)),
	);
	return state;
}
