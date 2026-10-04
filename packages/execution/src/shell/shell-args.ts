// Copyright (c) 2026 Igor Warzocha. MIT licensed.
// Shell argv policy carried from pi-codex-conversion b2006db9def12c373ae48e70044d30f7d6b7e34f.
export const CODEX_FALLBACK_SHELL = "/bin/bash";

export function isFishShell(shell: string | undefined): boolean {
	return shell?.replace(/\\/g, "/").split("/").pop()?.toLowerCase() === "fish";
}

export function getCodexRuntimeShell(
	shell: string | undefined,
	platform: string,
	defaultShell = CODEX_FALLBACK_SHELL,
): string {
	if (!shell) return defaultShell;
	if (!isFishShell(shell)) return shell;
	return platform === "win32" ? defaultShell : CODEX_FALLBACK_SHELL;
}

export function getShellArgs(
	shell: string,
	command: string,
	login: boolean,
): string[] {
	const name = shell.replace(/\\/g, "/").split("/").pop()?.toLowerCase();
	if (name === "cmd" || name === "cmd.exe") return ["/d", "/s", "/c", command];
	if (["powershell", "powershell.exe", "pwsh", "pwsh.exe"].includes(name ?? ""))
		return ["-NoLogo", "-NoProfile", "-Command", command];
	return login ? ["-lc", command] : ["-c", command];
}
