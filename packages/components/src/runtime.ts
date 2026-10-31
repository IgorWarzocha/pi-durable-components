import { type Context, isJsonValue } from "@earendil-works/chord";
import type { Provider } from "@earendil-works/pi-ai/models";
import type { Extension, JsonObject } from "@earendil-works/pi-durable";
import {
	type ComponentCapabilities,
	isCapabilityObject,
} from "./capabilities.ts";
import type {
	ComponentCompatibility,
	ComponentInstance,
	ComponentPackage,
} from "./contracts.ts";
import { PreparedComponents } from "./lifecycle.ts";
import { checkComponentCompatibility } from "./metadata.ts";

export { PreparedComponents } from "./lifecycle.ts";

import {
	ComponentRegistrations,
	isComponentInstance,
	isComponentModule,
} from "./registrations.ts";

export interface ComponentSelection {
	readonly id?: string;
	readonly manifest: ComponentPackage;
	readonly load: () => Promise<unknown>;
	readonly configuration?: JsonObject;
}

export interface PrepareComponentsOptions {
	readonly capabilities: ComponentCapabilities;
	readonly compatibility: Pick<ComponentCompatibility, "runtime" | "peers">;
	/** An observation barrier, never permission to cancel admitted work. */
	readonly whenIdle: (context: Context) => Promise<void>;
	readonly existing?: {
		readonly extensions: readonly Extension[];
		readonly providers: readonly Provider[];
	};
	readonly replace?: {
		readonly extensions?: readonly string[];
		readonly providers?: readonly string[];
	};
}

export interface PreparedComponent {
	readonly id: string;
	readonly manifest: ComponentPackage;
	readonly instance: ComponentInstance;
}

export interface ComponentData {
	readonly id: string;
	readonly manifest: ComponentPackage;
}

export interface SkippedComponent extends ComponentData {
	readonly reasons: readonly string[];
}

/** Failed preparation still exposes ownership when a cleanup hook needs retrying. */
export class ComponentPreparationError extends AggregateError {
	readonly prepared: PreparedComponents;
	constructor(prepared: PreparedComponents, errors: readonly unknown[]) {
		const reason =
			errors[0] instanceof Error ? errors[0].message : String(errors[0]);
		super(errors, `Component preparation failed: ${reason}`, {
			cause: errors[0],
		});
		this.prepared = prepared;
	}
}

export async function prepareComponents(
	selections: readonly ComponentSelection[],
	options: PrepareComponentsOptions,
	context: Context,
): Promise<PreparedComponents> {
	// Snapshot every caller-owned data input before the first module import/await.
	const capabilities = options.capabilities;
	const whenIdle = options.whenIdle;
	const ids = new Set<string>();
	const snapshots = selections.map((selection) => {
		const rawConfiguration =
			selection.configuration === undefined ? {} : selection.configuration;
		if (
			!isJsonValue(selection.manifest) ||
			!isCapabilityObject(selection.manifest) ||
			!isJsonValue(rawConfiguration) ||
			!isCapabilityObject(rawConfiguration)
		)
			throw new Error(
				"Component metadata and configuration must be strict JSON objects",
			);
		const manifest = structuredClone(selection.manifest);
		const configuration = structuredClone(rawConfiguration);
		const id = selection.id ?? `${manifest.name}@${manifest.version}`;
		if (!id || ids.has(id))
			throw new Error(`Duplicate or empty component selection ID: ${id}`);
		ids.add(id);
		return { id, manifest, configuration, load: selection.load };
	});
	const compatibility = {
		...options.compatibility,
		peers: { ...options.compatibility.peers },
		capabilities: capabilities.ids(),
	};
	const existing = {
		extensions: [...(options.existing?.extensions ?? [])],
		providers: [...(options.existing?.providers ?? [])],
	};
	const registrations = new ComponentRegistrations(
		existing,
		options.replace ?? {},
	);
	const components: PreparedComponent[] = [],
		libraries: ComponentData[] = [],
		skipped: SkippedComponent[] = [];
	const preflight = snapshots.map((selection) => ({
		selection,
		compatibility: checkComponentCompatibility(
			selection.manifest,
			compatibility,
		),
	}));
	const prepared = () =>
		new PreparedComponents(
			components,
			libraries,
			skipped,
			registrations,
			whenIdle,
			existing.extensions,
		);
	try {
		for (const { selection, compatibility } of preflight) {
			const { id, manifest, configuration } = selection;
			if (compatibility.status === "unsupported") {
				skipped.push({ id, manifest, reasons: compatibility.reasons });
				continue;
			}
			if (manifest.durable.kind === "library") {
				libraries.push({ id, manifest });
				continue;
			}
			const module = await selection.load();
			if (!isComponentModule(module))
				throw new Error(`Component ${id} does not export createComponent`);
			const instance = await module.createComponent({
				capabilities,
				configuration,
				context,
			});
			if (!isComponentInstance(instance))
				throw new Error(`Invalid component instance: ${id}`);
			components.push({ id, manifest, instance });
			registrations.add(instance);
		}
		return prepared();
	} catch (error) {
		const owned = prepared();
		const errors: unknown[] = [error];
		try {
			await owned.discardUnbound(context);
		} catch (cleanupError) {
			errors.push(cleanupError);
		}
		throw new ComponentPreparationError(owned, errors);
	}
}
