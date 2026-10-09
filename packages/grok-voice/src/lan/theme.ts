/** Host-owned browser presentation, independent of terminal rendering. */
export interface LanVoiceWebTheme {
	colorScheme: "dark" | "light" | "light dark";
	pageColor: string;
	variables: string;
}
export const DEFAULT_THEME: LanVoiceWebTheme = {
	colorScheme: "light dark",
	pageColor: "Canvas",
	variables: "",
};
export function resolveLanVoiceWebTheme(
	theme: LanVoiceWebTheme,
): LanVoiceWebTheme {
	return theme;
}
