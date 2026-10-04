export type ShellOutputStream = "stdout" | "stderr" | "pty";

export interface ShellSpawnRequest {
	readonly shell: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	readonly tty: boolean;
}

export interface ShellProcessEvents {
	/** Bytes may split UTF-8 characters. A backend can also deliver already-decoded text. */
	output(stream: ShellOutputStream, chunk: Uint8Array | string): void;
	/** Deliver once, after streams close or the backend's documented drain grace expires. */
	closed(exitCode: number): void;
}

export interface ShellProcess {
	write(chars: string): Promise<void>;
	/** Idempotent. Must stop the owned process and release streams before resolving. */
	terminate(): Promise<void>;
}

/** Explicit native process capability. Implement this for a sandbox or remote namespace. */
export interface ShellProcessBackend {
	readonly environmentId: string;
	readonly platform: string;
	readonly env: NodeJS.ProcessEnv;
	readonly defaultShell: string;
	/** Startup failure rejects. Never substitute a different host or process backend. */
	spawn(
		request: ShellSpawnRequest,
		events: ShellProcessEvents,
	): Promise<ShellProcess>;
}
