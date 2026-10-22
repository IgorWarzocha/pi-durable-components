import { type Context, copyJson, type JsonValue } from "@earendil-works/chord";
import { withoutAbortSignal } from "@earendil-works/chord/context";
import type {
	TaskRuntime,
	ToolControl,
	ToolExecutionApi,
	ToolExecutionResult,
	ToolRegistration,
} from "@earendil-works/pi-durable";
import type { CellCoordinatorOptions } from "./cell-contract.ts";
import { displayResult, forwardCall, forwardedStatus } from "./forwarding.ts";
import { executionError } from "./invocation.ts";
import { InvocationDoc, readStoredResult } from "./invocation-state.ts";
import { createNestedToolTask } from "./nested.ts";

/** Preserve invocation order for controls even when nested tools settle out of order. */
export function cellTools(
	runtime: Pick<
		TaskRuntime<unknown, unknown, unknown, Record<string, never>>,
		"taskId" | "signal" | "waitForTask" | "report"
	>,
	toolApi: ToolExecutionApi,
	registrations: readonly ToolRegistration[],
	nestedTask: ReturnType<typeof createNestedToolTask>,
	controls: (ToolControl | undefined)[],
	cancelTask: CellCoordinatorOptions["cancelTask"],
	cellContext: Context,
) {
	const tools: Record<
		string,
		(
			args: JsonValue,
			signal?: AbortSignal,
		) => Promise<ToolExecutionResult & { readonly callId: string }>
	> = Object.create(null);
	for (const registration of registrations)
		tools[registration.name] = async (args, signal) => {
			signal?.throwIfAborted();
			const owner = await toolApi.snapshot(
				InvocationDoc,
				runtime.taskId,
				cellContext,
			);
			const cellId = owner?.forwardingCellId;
			const position = controls.length;
			controls.push(undefined);
			const id = await toolApi.createTask(
				nestedTask,
				{
					name: registration.name,
					arguments: copyJson(args),
					parent: { taskId: runtime.taskId, callId: toolApi.callId },
					...(cellId === undefined ? {} : { cellId }),
				},
				// Cell recovery owns interruption; safe nested tools retain their recorded replay rule.
				{
					ownership: { kind: "task", taskId: runtime.taskId },
					abandonOnRestart: false,
				},
				cellContext,
			);
			let cancelling:
				| ReturnType<CellCoordinatorOptions["cancelTask"]>
				| undefined;
			const cancel = () => {
				// Cancellation is mandatory cleanup. The execution context is already aborted here.
				cancelling ??= cancelTask(id, withoutAbortSignal(cellContext));
				cancelling.catch((error) => {
					if (!runtime.signal.aborted) runtime.report(error);
				});
			};
			signal?.addEventListener("abort", cancel, { once: true });
			if (signal?.aborted) cancel();
			try {
				const settled = await runtime.waitForTask(id, cellContext);
				const result = readStoredResult(
					settled.state.outcome.result ??
						executionError(
							settled.state.outcome.status,
							"Nested tool did not return a result",
						),
				);
				controls[position] = result.control;
				await toolApi.commit(async (tx) => {
					const current =
						cellId === undefined
							? undefined
							: (
									await tx.doc(InvocationDoc, cellId)
								).forwardedToolCalls?.calls.find(
									(call) => call.callId === `nested-${id}`,
								);
					if (current !== undefined)
						await forwardCall(tx, cellId, {
							...current,
							status: forwardedStatus(
								result,
								settled.state.outcome.status === "completed"
									? "completed"
									: settled.state.outcome.status === "aborted"
										? "aborted"
										: "failed",
							),
							result: displayResult(result, owner?.forwardingBudget ?? 40000),
							omittedFields: current.omittedFields.filter(
								(field) => field !== "result",
							),
						});
				}, cellContext);
				return { ...result, callId: `nested-${id}` };
			} finally {
				signal?.removeEventListener("abort", cancel);
				if (cancelling !== undefined) await cancelling;
			}
		};

	return tools;
}
