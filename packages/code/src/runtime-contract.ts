export type RuntimeContentItem =
	| { type: "input_text"; text: string }
	| {
			type: "input_image";
			image_url: string;
			detail?: "auto" | "low" | "high" | "original" | null;
	  };

export interface RuntimeResponse {
	kind: "yielded" | "terminated" | "result";
	cellId: string;
	contentItems: RuntimeContentItem[];
	errorText?: string;
}

export interface RuntimeTool {
	name: string;
	description: string;
	inputSchema: unknown;
	invoke(input: unknown, signal: AbortSignal, callId: string): Promise<unknown>;
}

export interface RuntimeCallbacks {
	notify(text: string): Promise<void>;
	yield?(): Promise<void>;
}
