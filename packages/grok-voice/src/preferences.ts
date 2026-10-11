import {
	type SettingsDefinition,
	settingsObject,
} from "../../../internal/settings/index.ts";
import {
	DEFAULT_CONFIG,
	type GrokRealtimeConfig,
	normalizeConfig,
} from "./config.ts";

export const grokSettingsDefinition: SettingsDefinition<GrokRealtimeConfig> = {
	id: "howaboua.grok-voice",
	defaults: DEFAULT_CONFIG,
	validateOverride(value) {
		const supplied = settingsObject(value);
		const override = settingsObject({});
		// Validate fields independently. Cross-field constraints belong to the
		// effective config, where another scope can override either shortcut.
		for (const [key, field] of Object.entries(supplied)) {
			const normalized = settingsObject(
				normalizeConfig(
					{ [key]: field },
					{ ...DEFAULT_CONFIG, voiceShortcut: "", dictationShortcut: "" },
				),
			);
			override[key] = normalized[key]!;
		}
		return override;
	},
	resolve({ global, project }) {
		return normalizeConfig({ ...global, ...project }, DEFAULT_CONFIG);
	},
};
