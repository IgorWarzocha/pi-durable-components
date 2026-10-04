import type { Context, JsonValue } from "@earendil-works/chord";
import type {
	ConversationId,
	Harness,
	JsonObject,
	TaskId,
	ToolExecutionApi,
	ToolExecutionResult,
	ToolRegistration,
} from "@earendil-works/pi-durable";

/** Drivers own language/runtime globals. The coordinator owns durable execution and tool calls. */
export interface CellEngine {
	run(
		input: JsonObject,
		api: CellEngineApi,
		context: Context,
	): Promise<ToolExecutionResult>;
	close(): Promise<void>;
}

export interface CellEngineApi {
	readonly taskId: TaskId;
	readonly conversationId: ConversationId;
	readonly signal: AbortSignal;
	readonly toolApi: ToolExecutionApi;
	/** Current selected, wrapped registrations, excluding this execution surface. */
	readonly registrations: readonly ToolRegistration[];
	readonly tools: Readonly<
		Record<
			string,
			(args: JsonValue, signal?: AbortSignal) => Promise<ToolExecutionResult>
		>
	>;
	/** Replace the durable driver snapshot, including text, images and runtime errors. */
	publish(result: ToolExecutionResult, context: Context): Promise<void>;
	/** Wake exec/wait observers without settling or cancelling this cell. */
	requestYield(context: Context): Promise<void>;
	/** Optional driver-specific progress, persisted without a provider transcript. */
	checkpoint(value: JsonValue, context: Context): Promise<void>;
}

export type CellObservation = {
	readonly cellId: TaskId<ToolExecutionResult>;
	readonly status:
		| "running"
		| "completed"
		| "failed"
		| "aborted"
		| "interrupted";
	readonly result: ToolExecutionResult;
	readonly checkpoint?: JsonValue;
};

export type CellCoordinatorOptions = {
	readonly name: string;
	readonly engine: CellEngine;
	readonly surfaceTools: readonly string[];
	/** Individual task cancellation is a host operation, not part of the tool invocation API. */
	readonly cancelTask: (
		id: TaskId,
		context: Context,
	) => ReturnType<Harness["abortTask"]>;
};
