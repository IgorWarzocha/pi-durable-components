import {
	executionCapability,
	executionDetail,
	executionSummary,
} from "../../execution/src/presentation.ts";

export type {
	ForwardedToolCall,
	ForwardedToolCalls,
	ForwardedToolStatus,
} from "../../execution/src/forwarded-tools.ts";
export { parseForwardedToolCalls } from "../../execution/src/forwarded-tools.ts";

export type {
	ExecutionCellReference,
	ExecutionCellStatus,
	ExecutionPresentationState as WorkerCodePresentationState,
	ExecutionResultReceipt,
	ExecutionSummaryModel,
} from "../../execution/src/presentation.ts";

/** Host binds ordinary registrations and publishes acquired observations on results. */
export const workerCodeCapability = executionCapability("worker-code", [
	"exec",
	"wait",
]);
export const workerCodeSummary = executionSummary("Worker Code");
export const workerCodeDetail = executionDetail;
