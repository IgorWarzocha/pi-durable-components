/** Host CSS palette, not an emulation of Pi's terminal Theme. */
export interface GippityWebTheme {
	pageColor: string;
	colorScheme: "dark" | "light";
	colors: Readonly<Record<string, string>>;
}
export const DEFAULT_GIPPITY_WEB_THEME: GippityWebTheme = {
	pageColor: "#171a21",
	colorScheme: "dark",
	colors: {
		text: "#ebedf0",
		accent: "#93b9ff",
		muted: "#a7afbd",
		dim: "#747f90",
		success: "#91d5a2",
		warning: "#ffd28a",
		"user-message-bg": "#171a21",
		"tool-pending-bg": "#202632",
		"selected-bg": "#293650",
		"border-muted": "#394456",
		border: "#586783",
		"tool-success-bg": "#243d30",
		"custom-message-bg": "#242c3b",
	},
};
export function resolveLanVoiceWebTheme(theme: GippityWebTheme) {
	const valid = (value: string) => {
		if (!/^#[0-9a-f]{6}$/i.test(value))
			throw new Error("Web palette requires six-digit hex colors");
		return value;
	};
	const colors = { ...DEFAULT_GIPPITY_WEB_THEME.colors, ...theme.colors };
	return {
		pageColor: valid(theme.pageColor),
		colorScheme: theme.colorScheme,
		variables: Object.entries(colors)
			.map(([name, value]) => {
				if (!/^[a-z-]+$/.test(name))
					throw new Error("Invalid palette color name");
				return `--pi-${name}:${valid(value)}`;
			})
			.join(";"),
	};
}
