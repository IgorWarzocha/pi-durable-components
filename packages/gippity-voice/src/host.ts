import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { GippityControlConfig } from "./config.ts";

/** Pass the SAME host instance to every voice product in this application. */
export interface AudioLease {
	acquire(
		request: { owner: string; mode: "voice" | "dictation" },
		signal: AbortSignal,
	): Promise<{ release(): Promise<void> }>;
}

/** Credential-free process permission, bound to the conversation environment. */
export interface GippityAudioHost {
	readonly namespace: string;
	launch(): ChildProcessWithoutNullStreams;
}

export interface GippitySettingsStore {
	read(): Promise<unknown>;
	write(config: GippityControlConfig): Promise<void>;
}

export interface GippityAsset {
	contentType: string;
	body: Uint8Array;
}

/** The host enforces real-path containment and the conversation namespace. */
export interface GippityAppFiles {
	readonly namespace: string;
	read(root: string, path: string): Promise<GippityAsset | undefined>;
}

export interface GippityLanPermission {
	readonly namespace: string;
	key: string | Buffer;
	cert: string | Buffer;
	bind: string;
	port: number;
	/** Explicit permitted HTTPS origins, including every advertised hostname. */
	origins: readonly string[];
}

export type GippityPresentation =
	| { type: "status"; status: string }
	| { type: "error"; message: string }
	| { type: "transcript"; role: "user" | "assistant"; text: string }
	| { type: "context"; summary: string }
	| { type: "draft"; text: string }
	| { type: "activity"; state: "working" | "waiting" | "idle"; text?: string }
	| { type: "lifecycle"; active: boolean };
