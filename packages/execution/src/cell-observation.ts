import type { Context } from "@earendil-works/chord";
import {
	defineDocFamily,
	type TaskId,
	type ToolExecutionApi,
	type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import type { CellObservation } from "./cell-contract.ts";
import { InvocationDoc, type InvocationState } from "./invocation.ts";
/** Task documents retire on settlement. Completed cells retain driver snapshots here. */
export const CellStateDoc = defineDocFamily<InvocationState, null>({
	kind: "howaboua.execution.cells",
	family: true,
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ result: {} }),
});

export async function observeCell(
	kind: string,
	id: TaskId<ToolExecutionResult>,
	api: ToolExecutionApi,
	context: Context,
): Promise<CellObservation> {
	const record = await api.getTask(id, context);
	if (
		record === undefined ||
		record.kind !== kind ||
		record.conversationId !== api.conversationId
	)
		throw new Error(`Unknown cell ${id}`);
	const doc =
		(await api.snapshot(InvocationDoc, id, context)) ??
		(await api.snapshot(CellStateDoc, api.conversationId, String(id), context));
	const outcome =
		record.state.status === "terminal" ? record.state.outcome : undefined;
	const result = outcome?.result ?? doc?.result ?? {};
	const interrupted =
		result.diagnostics?.some((each) => each.code === "interrupted") ?? false;
	const status = interrupted
		? "interrupted"
		: outcome?.status === "completed"
			? "completed"
			: outcome?.status === "aborted"
				? "aborted"
				: outcome !== undefined
					? "failed"
					: "running";
	return {
		cellId: id,
		status,
		result,
		...(doc?.checkpoint === undefined ? {} : { checkpoint: doc.checkpoint }),
	};
}
