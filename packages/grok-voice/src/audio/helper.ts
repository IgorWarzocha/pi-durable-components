import type { ChildProcessWithoutNullStreams } from "node:child_process";
/** Explicit grant to run the bundled credential-free helper. No host fallback. */
export interface NativeAudioProcess {
	spawn(args: readonly string[]): ChildProcessWithoutNullStreams;
	execute(args: readonly string[], signal: AbortSignal): Promise<string>;
}
/** Package asset location only; the host authorizes execution and supplies environment. */
export function audioHelperUrl(platform: string, arch: string): URL {
	if (
		!["linux", "darwin", "win32"].includes(platform) ||
		!["x64", "arm64"].includes(arch)
	)
		throw new Error(`Local audio is not supported on ${platform}-${arch}`);
	const base = import.meta.url.endsWith("/helper.ts") ? "./bin" : "./audio/bin";
	return new URL(
		`${base}/${platform}-${arch}/grok-audio${platform === "win32" ? ".exe" : ""}`,
		import.meta.url,
	);
}
