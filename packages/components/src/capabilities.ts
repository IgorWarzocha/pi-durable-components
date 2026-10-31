/** A versioned, public capability port. Parsing never acquires the resource. */
export interface ComponentCapability<Value> {
	readonly id: string;
	parse(value: unknown): Value;
}

export function defineCapability<Value>(
	id: string,
	check: (value: unknown) => value is Value,
): ComponentCapability<Value> {
	if (!/^[a-z][a-z0-9.-]*\.v[1-9][0-9]*$/.test(id))
		throw new Error("Capability IDs must be namespaced and end in .v<version>");
	return {
		id,
		parse(value) {
			if (!check(value)) throw new Error(`Invalid host capability: ${id}`);
			return value;
		},
	};
}

/**
 * Explicit in-process grants, not a sandbox. IDs cross independently installed
 * package copies; the receiving package validates the granted value again.
 */
export class ComponentCapabilities {
	private readonly values = new Map<string, unknown>();

	provide<Value>(key: ComponentCapability<Value>, value: Value): this {
		if (this.values.has(key.id))
			throw new Error(`Host capability already provided: ${key.id}`);
		this.values.set(key.id, key.parse(value));
		return this;
	}

	has(id: string): boolean {
		return this.values.has(id);
	}

	ids(): ReadonlySet<string> {
		return new Set(this.values.keys());
	}

	get<Value>(key: ComponentCapability<Value>): Value {
		if (!this.values.has(key.id))
			throw new Error(`Missing host capability: ${key.id}`);
		return key.parse(this.values.get(key.id));
	}
}

export function isCapabilityObject(
	value: unknown,
): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
