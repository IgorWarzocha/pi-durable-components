import {
	copyJson,
	type JsonRepresentation,
	type JsonValue,
} from "@earendil-works/chord";
import {
	defineDoc,
	type TaskId,
	type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import type { ForwardedToolCalls } from "./forwarded-tools.ts";

type StoredResult = JsonRepresentation<ToolExecutionResult>;
export type InvocationState = {
	result: StoredResult;
	checkpoint?: JsonValue;
	yieldCount?: number;
	droppedBytes?: number;
	droppedLines?: number;
	forwardingCellId?: TaskId;
	forwardingBudget?: number;
	forwardedToolCalls?: JsonRepresentation<ForwardedToolCalls>;
	/** Admission identities only, bounded to retained display calls; native slots may retire first. */
	forwardedNativeTasks?: {
		callId: string;
		taskId: TaskId;
		ownerTaskId: TaskId;
	}[];
};

export const InvocationDoc = defineDoc<InvocationState>({
	kind: "howaboua.execution.invocation",
	version: 2,
	scope: "task",
	checkpointWhen: () => false,
	initial: () => ({ result: {} }),
	migrate: (value) => ({
		...value,
		result: storeResult(
			readStoredResult(value["result"] as ToolExecutionResult),
		),
	}),
});

/** Version-one task receipts remain readable after their task documents retire. */
export function readStoredResult(
	result: ToolExecutionResult,
): ToolExecutionResult {
	if (result.output !== undefined || !("content" in result)) return result;
	const { content, ...rest } = result;
	return {
		...rest,
		output: content as NonNullable<ToolExecutionResult["output"]>,
	};
}

export function storeResult(result: ToolExecutionResult): StoredResult {
	return copyJson(result, { omitUndefinedProperties: true }) as StoredResult;
}
