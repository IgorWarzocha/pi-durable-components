import { CODEX_TOOL_ORIGINATOR, type CodexToolProvider } from "./types.ts";

export function codexToolProviderHeaders(
	provider: CodexToolProvider,
	runtime: "node" | "workerd" = "node",
): Headers {
	const headers = new Headers();
	headers.set("originator", CODEX_TOOL_ORIGINATOR);
	headers.set(
		"User-Agent",
		runtime === "workerd"
			? CODEX_TOOL_ORIGINATOR + "/0.0.0 (workerd)"
			: codexWebRunUserAgent(CODEX_TOOL_ORIGINATOR),
	);
	headers.set("version", "0.0.0");
	headers.set("content-type", "application/json");
	for (const [name, value] of Object.entries(provider.headers ?? {})) {
		if (value === null) headers.delete(name);
		else if (typeof value === "string") headers.set(name, value);
	}
	// Route-specific credential precedence is decided by the auth resolver.
	headers.set("Authorization", "Bearer " + provider.token);
	headers.set("ChatGPT-Account-ID", provider.accountId);
	return headers;
}

function codexWebRunUserAgent(
	originator: string = CODEX_TOOL_ORIGINATOR,
): string {
	const platform =
		process.platform === "darwin"
			? "Mac OS"
			: process.platform === "win32"
				? "Windows"
				: process.platform === "linux"
					? "Linux"
					: process.platform;
	const arch = process.arch === "arm64" ? "arm64" : process.arch;
	const terminal =
		process.env["TERM_PROGRAM"]?.trim() ||
		process.env["TERM"]?.trim() ||
		"unknown";
	return (
		originator + "/0.0.0 (" + platform + " unknown; " + arch + ") " + terminal
	);
}
