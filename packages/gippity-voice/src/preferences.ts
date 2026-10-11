import {
	DEFAULT_GIPPITY_CONTROL_CONFIG,
	type GippityControlConfig,
	REALTIME_V3_VOICES,
	VOICE_CONTEXT_REASONING_LEVELS,
} from "./config.ts";

export type GippityPreferences = {
	lan?: Partial<{
		[K in keyof GippityControlConfig["lan"]]:
			| GippityControlConfig["lan"][K]
			| (undefined extends GippityControlConfig["lan"][K] ? null : never);
	}>;
	voice?: Partial<{
		[K in keyof GippityControlConfig["voice"]]:
			| GippityControlConfig["voice"][K]
			| (undefined extends GippityControlConfig["voice"][K] ? null : never);
	}>;
};

function object(value: unknown, path: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`${path} must be an object`);
	return value as Record<string, unknown>;
}

function text(value: unknown): boolean {
	return (
		typeof value === "string" &&
		Boolean(value.trim()) &&
		Buffer.byteLength(value) <= 512
	);
}

/** Persistence is strict. The legacy config normalizer remains deliberately permissive. */
export function validateGippityPreferences(value: unknown): GippityPreferences {
	const root = object(value, "GipPity settings");
	for (const [section, raw] of Object.entries(root)) {
		if (section !== "voice" && section !== "lan")
			throw new Error(`Unknown GipPity setting: ${section}`);
		for (const [key, field] of Object.entries(object(raw, section))) {
			let valid = false;
			if (section === "lan") {
				if (key === "customWebApp") valid = typeof field === "boolean";
				else if (key === "customWebAppPath")
					valid = field === null || text(field);
				else if (key === "port")
					valid =
						field === null ||
						(typeof field === "number" &&
							Number.isInteger(field) &&
							field >= 1 &&
							field <= 65_535);
			} else if (key === "contextModel") {
				if (field === null) valid = true;
				else {
					const model = object(field, "voice.contextModel");
					valid =
						Object.keys(model).length === 2 &&
						text(model["provider"]) &&
						text(model["modelId"]);
				}
			} else if (key === "v3Voice" || key === "v3AlternateVoice") {
				valid = REALTIME_V3_VOICES.some((voice) => voice === field);
			} else if (key === "contextReasoning") {
				valid = VOICE_CONTEXT_REASONING_LEVELS.some((level) => level === field);
			} else if (key === "dictationShortcutMode") {
				valid = field === "push" || field === "toggle";
			} else if (key === "inputDevice" || key === "outputDevice") {
				valid = field === null || text(field);
			} else if (Object.hasOwn(DEFAULT_GIPPITY_CONTROL_CONFIG.voice, key)) {
				const fallback =
					DEFAULT_GIPPITY_CONTROL_CONFIG.voice[
						key as keyof GippityControlConfig["voice"]
					];
				valid =
					typeof fallback === "boolean"
						? typeof field === "boolean"
						: text(field);
			}
			if (!valid) throw new Error(`Invalid GipPity setting: ${section}.${key}`);
		}
	}
	return structuredClone(root) as GippityPreferences;
}

export function mergeGippityPreferences(
	...layers: readonly GippityPreferences[]
): GippityControlConfig {
	const result = structuredClone(DEFAULT_GIPPITY_CONTROL_CONFIG);
	for (const layer of layers) {
		Object.assign(result.lan, layer.lan);
		Object.assign(result.voice, layer.voice);
	}
	for (const section of [result.lan, result.voice]) {
		for (const key of Object.keys(section)) {
			if (Reflect.get(section, key) === null)
				Reflect.deleteProperty(section, key);
		}
	}
	return result;
}

/** Only changed effective leaves become overrides. Untouched inherited values stay inherited. */
export function changedGippityPreferences(
	current: GippityControlConfig,
	next: GippityControlConfig,
	target: GippityPreferences,
): GippityPreferences {
	const result = structuredClone(target);
	for (const section of ["lan", "voice"] as const) {
		const overrides: Record<string, unknown> = { ...result[section] };
		const keys = new Set([
			...Object.keys(current[section]),
			...Object.keys(next[section]),
		]);
		for (const key of keys) {
			const before = Reflect.get(current[section], key);
			const after = Reflect.get(next[section], key);
			if (JSON.stringify(before) !== JSON.stringify(after))
				overrides[key] = after ?? null;
		}
		if (Object.keys(overrides).length) Reflect.set(result, section, overrides);
	}
	return validateGippityPreferences(result);
}
