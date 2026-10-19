// Adapted from @howaboua/pi-codex-conversion, MIT. See ../NOTICE.
export const HOST_RELEASE = "rust-v0.163.0";

const HOST_ASSETS = {
	"darwin-arm64": [
		"codex-code-mode-host-aarch64-apple-darwin.tar.gz",
		"2e28f49a4767a97586843c92692b96481be74d837199b49038f731cec88e9941",
	],
	"darwin-x64": [
		"codex-code-mode-host-x86_64-apple-darwin.tar.gz",
		"5211c6ed5062c84ba5796e555903c22a6e38fcccf6fe11ee11d7e1b5687ce1fd",
	],
	"linux-arm64": [
		"codex-code-mode-host-aarch64-unknown-linux-musl.tar.gz",
		"284356aefb197f00b76b912efdfdbae8ccf3ea1f89b976dde064b7ccb43214ef",
	],
	"linux-x64": [
		"codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz",
		"314263128ba6592e7e807c265deeaf928a692b72dcbfeb5e0b20c9423b703529",
	],
	"win32-arm64": [
		"codex-code-mode-host-aarch64-pc-windows-msvc.exe",
		"8abfb32791949287a132289a6633fb4e7d79bb616f01244fe2782da226755160",
	],
	"win32-x64": [
		"codex-code-mode-host-x86_64-pc-windows-msvc.exe",
		"07f3869f0849cd54b31cec1f86ec796f004501bd3a215135c1facc883a2b9988",
	],
} as const;

export function codeModeHostBinaryName(platform: string): string {
	return platform === "win32"
		? "codex-code-mode-host.exe"
		: "codex-code-mode-host";
}

export function resolveCodeModeHostAsset(
	platform: string,
	arch: string,
): readonly [string, string] {
	const asset = (HOST_ASSETS as Record<string, readonly [string, string]>)[
		`${platform}-${arch}`
	];
	if (!asset)
		throw new Error(`Unsupported code-mode platform: ${platform}-${arch}`);
	return asset;
}

export function hostAssetUrl(assetName: string): string {
	return `https://github.com/openai/codex/releases/download/${HOST_RELEASE}/${assetName}`;
}
