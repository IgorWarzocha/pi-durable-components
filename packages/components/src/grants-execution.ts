import { defineCapability, isCapabilityObject } from "./capabilities.ts";

/**
 * Explicit authority to use trusted Node-native runtimes in this verified local namespace,
 * not an isolation boundary. Non-shell workers inherit the Node process environment unless
 * their runtime exposes an explicit override.
 */
export interface NodeExecutionGrant {
	readonly environmentId: string;
	/** Complete child shell environment; absence of a key does not inherit it from the host. */
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly defaultShell: string;
}

export const nodeExecutionCapability = defineCapability<NodeExecutionGrant>(
	"durable.node-execution.v1",
	(value): value is NodeExecutionGrant =>
		isCapabilityObject(value) &&
		typeof value["environmentId"] === "string" &&
		value["environmentId"].length > 0 &&
		typeof value["defaultShell"] === "string" &&
		value["defaultShell"].length > 0 &&
		isCapabilityObject(value["env"]) &&
		Object.values(value["env"]).every(
			(entry) => entry === undefined || typeof entry === "string",
		),
);

/** Host-bundled WASM indexed by engine ABI, not by component package identity. */
export interface CompiledWasmGrant {
	moduleFor(abi: string): WebAssembly.Module;
}

export const compiledWasmCapability = defineCapability<CompiledWasmGrant>(
	"durable.compiled-wasm.v1",
	(value): value is CompiledWasmGrant =>
		isCapabilityObject(value) && typeof value["moduleFor"] === "function",
);

export interface ExecutionStoragePolicy {
	readonly journals?: "off" | "week" | "on";
	readonly checkpointCleanup?: "never" | "month" | "week";
}

/** Live host retention policy, read at the owning runtime's write/maintenance boundaries. */
export interface StoragePolicyGrant {
	policy(namespace: string): ExecutionStoragePolicy;
}

export const storagePolicyCapability = defineCapability<StoragePolicyGrant>(
	"durable.storage-policy.v1",
	(value): value is StoragePolicyGrant =>
		isCapabilityObject(value) && typeof value["policy"] === "function",
);
