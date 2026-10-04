// Adapted from pi-codex-conversion at b2006db9def12c373ae48e70044d30f7d6b7e34f, MIT. See ../NOTICE.
export interface NotebookSessionContext {
	cwd: string;
	sessionId: string;
}
export interface NotebookRuntimeOptions {
	maxHeapMiB: number;
	agentDir: string;
	profile?: string | undefined;
	env?: NodeJS.ProcessEnv | undefined;
}
export interface ToolExecutionContext {
	cwd: string;
	sessionContext: NotebookSessionContext;
	onUpdate?:
		| ((result: {
				content: Array<
					| { type: "text"; text: string }
					| { type: "image"; data: string; mimeType: string }
				>;
				details?: unknown;
		  }) => void)
		| undefined;
	setBlocked?: ((id: string, active: boolean) => void) | undefined;
	onYield?: (() => Promise<void>) | undefined;
}
export interface NotebookToolIdentity {
	name: string;
	namespace?: string | undefined;
}
export interface NotebookToolDefinition {
	name: string;
	description: string;
	usage: string;
	help?: string | undefined;
	textOutput?: "command" | "plain-command" | undefined;
	invoke(
		input: unknown,
		context: ToolExecutionContext,
		signal: AbortSignal,
	): Promise<unknown>;
}
export interface NotebookExecutionClient {
	execute(
		source: string,
		context: ToolExecutionContext,
		signal?: AbortSignal,
		tools?: NotebookToolDefinition[],
	): Promise<RuntimeResponse>;
	wait(
		cellId: string,
		yieldTimeMs: number,
		context: ToolExecutionContext,
		signal?: AbortSignal,
	): Promise<RuntimeResponse>;
	terminate(
		cellId: string,
		context: ToolExecutionContext,
		signal?: AbortSignal,
	): Promise<RuntimeResponse>;
	shutdown(): Promise<void>;
}
export interface RuntimeContentItem {
	type: "input_text" | "input_image";
	text?: string;
	image_url?: string;
	detail?: "auto" | "low" | "high" | "original" | null;
}

export interface NotebookMemoryUsage {
	heapUsedBytes: number;
	heapTotalBytes: number;
	rssBytes: number;
	externalBytes: number;
	heapLimitBytes: number;
}

export type NotebookHook = "startup" | "tool_result";

export type NotebookControlRequest =
	| { action: "status"; query?: string | undefined }
	| { action: "list"; query?: string | undefined }
	| { action: "checkpoint" }
	| { action: "save"; name: string }
	| { action: "load"; name: string }
	| { action: "pin"; names: string[]; hook?: NotebookHook | false | undefined }
	| { action: "unpin"; names: string[] }
	| { action: "release"; names: string[] }
	| { action: "prune"; query: string }
	| { action: "restart" }
	| { action: "diagnostics" }
	| { action: "reset" };

export interface NotebookControlResult {
	message: string;
	details: Record<string, unknown>;
}

export type RuntimeResponse = (
	| { kind: "yielded"; cellId: string; contentItems: RuntimeContentItem[] }
	| { kind: "terminated"; cellId: string; contentItems: RuntimeContentItem[] }
	| {
			kind: "result";
			cellId: string;
			contentItems: RuntimeContentItem[];
			errorText?: string | undefined;
	  }
) & {
	maxOutputTokens?: number | undefined;
	missingCell?: true | undefined;
	notebookMemory?: NotebookMemoryUsage | undefined;
};
