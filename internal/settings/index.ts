export type SettingsValue =
	| null
	| boolean
	| number
	| string
	| SettingsValue[]
	| { [key: string]: SettingsValue };
export type SettingsObject = { [key: string]: SettingsValue };
export type SettingsScope = "global" | "project";
export type SettingsOverrides = Record<SettingsScope, SettingsObject | null>;

export interface StoredSettings {
	revision: string;
	overrides: SettingsOverrides;
	/** Null means that scope is unavailable, not that its file is absent. */
	sources: Record<SettingsScope, string | null>;
}
export interface SettingsWrite {
	scope: SettingsScope;
	/** Null removes this scope's override and restores inheritance. */
	value: SettingsObject | null;
	expectedRevision: string;
}

/** Explicit host-granted persistence. Implementations must compare and write atomically among their writers. */
export interface SettingsStorage {
	readonly id: string;
	read(signal?: AbortSignal): Promise<StoredSettings>;
	replaceOverride(
		request: SettingsWrite,
		signal?: AbortSignal,
	): Promise<StoredSettings>;
}
export type SettingsApplication =
	| { status: "applied" | "next-use" | "restart-required"; message?: string }
	| { status: "failed"; message: string };
export interface SettingsSnapshot<T extends object = SettingsObject>
	extends StoredSettings {
	id: string;
	defaults: T;
	effective: T;
}
export interface SettingsChange<T extends object = SettingsObject> {
	snapshot: SettingsSnapshot<T>;
	application: SettingsApplication;
}
export interface SettingsContribution<T extends object = SettingsObject> {
	readonly id: string;
	read(signal?: AbortSignal): Promise<SettingsSnapshot<T>>;
	replaceOverride(
		request: SettingsWrite,
		signal?: AbortSignal,
	): Promise<SettingsChange<T>>;
}
export interface SettingsDefinition<T extends object> {
	id: string;
	defaults: T;
	/** Validate a partial override. Do not fill defaults into persisted overrides. */
	validateOverride(value: unknown): SettingsObject;
	/** This component, not its UI or storage adapter, owns field merge semantics. */
	resolve(overrides: SettingsOverrides): T;
}

export class SettingsError extends Error {
	readonly code: "invalid" | "conflict" | "unavailable" | "busy";
	constructor(
		code: "invalid" | "conflict" | "unavailable" | "busy",
		message: string,
	) {
		super(message);
		this.code = code;
		this.name = "SettingsError";
	}
}

/** Validate without coercion or JSON.stringify's silent omission of unsupported values. */
export function settingsObject(value: unknown): SettingsObject {
	const seen = new Set<object>();
	function check(item: unknown): boolean {
		if (item === null || typeof item === "string" || typeof item === "boolean")
			return true;
		if (typeof item === "number") return Number.isFinite(item);
		if (typeof item !== "object" || seen.has(item)) return false;
		if (
			!Array.isArray(item) &&
			Object.getPrototypeOf(item) !== Object.prototype &&
			Object.getPrototypeOf(item) !== null
		)
			return false;
		seen.add(item);
		const valid =
			Reflect.ownKeys(item).every((key) => typeof key === "string") &&
			(Array.isArray(item) ? [...item] : Object.values(item)).every(check);
		seen.delete(item);
		return valid;
	}
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		!check(value)
	)
		throw new SettingsError(
			"invalid",
			"Settings must be a JSON object containing only finite JSON values",
		);
	return structuredClone(value) as SettingsObject;
}

export function createSettingsContribution<T extends object>(options: {
	definition: SettingsDefinition<T>;
	storage: SettingsStorage;
	/** Called only after persistence. Failure is reported as saved but not applied. */
	apply?(effective: T, signal?: AbortSignal): Promise<SettingsApplication>;
}): SettingsContribution<T> {
	const { definition, storage } = options;
	if (
		!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(definition.id) ||
		storage.id !== definition.id
	)
		throw new SettingsError(
			"invalid",
			"Settings definition and storage must have the same stable filesystem-safe ID",
		);
	settingsObject(definition.defaults);
	const defaults = structuredClone(definition.defaults);
	let serial = Promise.resolve();
	function validate(
		value: SettingsObject | null,
		scope: SettingsScope,
	): SettingsObject | null {
		if (value === null) return null;
		try {
			return settingsObject(definition.validateOverride(settingsObject(value)));
		} catch (error) {
			throw new SettingsError(
				"invalid",
				`${definition.id} ${scope}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	function snapshot(stored: StoredSettings): SettingsSnapshot<T> {
		const overrides = {
			global: validate(stored.overrides.global, "global"),
			project: validate(stored.overrides.project, "project"),
		};
		const effective = definition.resolve(structuredClone(overrides));
		settingsObject(effective);
		return {
			...structuredClone(stored),
			overrides,
			id: definition.id,
			defaults: structuredClone(defaults),
			effective: structuredClone(effective),
		};
	}
	return {
		id: definition.id,
		async read(signal) {
			signal?.throwIfAborted();
			return snapshot(await storage.read(signal));
		},
		replaceOverride(request, signal) {
			// Detach caller-owned arguments before awaiting any operation.
			const input = structuredClone(request);
			const operation = serial.then(async () => {
				signal?.throwIfAborted();
				if (input.scope !== "global" && input.scope !== "project")
					throw new SettingsError("invalid", "Unknown settings scope");
				const current = await storage.read(signal);
				if (current.revision !== input.expectedRevision)
					throw new SettingsError(
						"conflict",
						"Settings changed since they were read; reload before saving",
					);
				if (current.sources[input.scope] === null)
					throw new SettingsError(
						"unavailable",
						`${input.scope} settings are not configured`,
					);
				const value = validate(input.value, input.scope);
				// Validate the complete candidate before committing, including cross-field constraints.
				snapshot({
					...current,
					overrides: { ...current.overrides, [input.scope]: value },
				});
				const saved = snapshot(
					await storage.replaceOverride({ ...input, value }, signal),
				);
				let application: SettingsApplication;
				try {
					application = options.apply
						? await options.apply(structuredClone(saved.effective), signal)
						: {
								status: "restart-required",
								message: "Saved. No live settings application is bound.",
							};
				} catch (error) {
					application = {
						status: "failed",
						message: `Settings were saved but not applied: ${error instanceof Error ? error.message : String(error)}`,
					};
				}
				return { snapshot: saved, application };
			});
			serial = operation.then(
				() => {},
				() => {},
			);
			return operation;
		},
	};
}
