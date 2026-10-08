import {
	executionCapability,
	executionDetail,
	executionSummary,
} from "../../execution/src/presentation.ts";

export type {
	ExecutionCellReference,
	ExecutionCellStatus,
	ExecutionPresentationState as NotebookPresentationState,
	ExecutionResultReceipt,
	ExecutionSummaryModel,
} from "../../execution/src/presentation.ts";

/** Host binds ordinary registrations and publishes acquired observations on results. */
export const notebookCapability = executionCapability("notebook", [
	"exec",
	"wait",
	"notebook",
]);
export const notebookSummary = executionSummary("Notebook");
export const notebookDetail = executionDetail;
