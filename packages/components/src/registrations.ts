import type { Provider } from "@earendil-works/pi-ai/models";
import type { Extension } from "@earendil-works/pi-durable";
import { isCapabilityObject } from "./capabilities.ts";
import type { ComponentInstance, ComponentModule } from "./contracts.ts";

export function isComponentModule(value: unknown): value is ComponentModule {
	return (
		isCapabilityObject(value) && typeof value["createComponent"] === "function"
	);
}

/** Acquire cleanup ownership before inspecting individual registrations. */
export function isComponentInstance(
	value: unknown,
): value is ComponentInstance {
	return (
		isCapabilityObject(value) &&
		(value["extensions"] === undefined || Array.isArray(value["extensions"])) &&
		(value["providers"] === undefined || Array.isArray(value["providers"])) &&
		(value["retention"] === undefined ||
			value["retention"] === "idle" ||
			value["retention"] === "harness") &&
		["bind", "stopAdmission", "beforeClose", "afterClose", "maintain"].every(
			(key) => value[key] === undefined || typeof value[key] === "function",
		) &&
		(value["admission"] === undefined ||
			(isCapabilityObject(value["admission"]) &&
				Array.isArray(value["admission"]["extensions"]) &&
				value["admission"]["extensions"].every(isIdentity) &&
				typeof value["admission"]["submit"] === "function" &&
				(value["admission"]["rejoin"] === undefined ||
					typeof value["admission"]["rejoin"] === "function")))
	);
}

function isIdentity(value: unknown): value is string {
	return (
		typeof value === "string" && value.length > 0 && value.trim() === value
	);
}

export class ComponentRegistrations {
	readonly extensions: Extension[] = [];
	readonly providers: Provider[] = [];
	private readonly extensionNames = new Set<string>();
	private readonly providerIds = new Set<string>();
	private readonly existingExtensions: Set<string>;
	private readonly existingProviders: Set<string>;
	private readonly replaceExtensions: Set<string>;
	private readonly replaceProviders: Set<string>;

	constructor(
		existing: {
			readonly extensions: readonly Extension[];
			readonly providers: readonly Provider[];
		},
		replace: {
			readonly extensions?: readonly string[];
			readonly providers?: readonly string[];
		},
	) {
		this.existingExtensions = new Set(
			existing.extensions.map((extension) => extension.name),
		);
		this.existingProviders = new Set(
			existing.providers.map((provider) => provider.id),
		);
		this.replaceExtensions = new Set(replace.extensions ?? []);
		this.replaceProviders = new Set(replace.providers ?? []);
		for (const name of [...this.replaceExtensions, ...this.replaceProviders])
			if (!isIdentity(name))
				throw new Error("Replacement requires exact registration identities");
	}

	add(instance: ComponentInstance): void {
		for (const extension of instance.extensions ?? []) {
			if (!isCapabilityObject(extension) || !isIdentity(extension["name"]))
				throw new Error("Component returned an invalid extension identity");
			if (
				extension.tools !== undefined &&
				(!Array.isArray(extension.tools) ||
					!extension.tools.every(
						(tool: unknown) =>
							isCapabilityObject(tool) && isIdentity(tool["name"]),
					))
			)
				throw new Error(
					`Invalid tool registrations in extension: ${extension.name}`,
				);
			this.claim(
				extension.name,
				this.extensionNames,
				this.existingExtensions,
				this.replaceExtensions,
				"extension",
			);
			this.extensions.push(extension);
		}
		for (const provider of instance.providers ?? []) {
			if (
				!isCapabilityObject(provider) ||
				!isIdentity(provider["id"]) ||
				typeof provider["getModels"] !== "function"
			)
				throw new Error("Component returned an invalid provider identity");
			this.claim(
				provider.id,
				this.providerIds,
				this.existingProviders,
				this.replaceProviders,
				"provider",
			);
			this.providers.push(provider);
		}
		for (const name of instance.admission?.extensions ?? [])
			if (!instance.extensions?.some((extension) => extension.name === name))
				throw new Error(
					`Admission names an extension not owned by its component: ${name}`,
				);
	}

	private claim(
		name: string,
		added: Set<string>,
		existing: Set<string>,
		replace: Set<string>,
		kind: string,
	): void {
		if (added.has(name))
			throw new Error(`Duplicate new ${kind} registration: ${name}`);
		if (existing.has(name) && !replace.has(name))
			throw new Error(
				`Existing ${kind} registration requires explicit replacement: ${name}`,
			);
		added.add(name);
	}
}
