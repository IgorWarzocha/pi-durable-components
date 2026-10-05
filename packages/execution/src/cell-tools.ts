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
import { executionError } from "./invocation.ts";
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
		(args: JsonValue, signal?: AbortSignal) => Promise<ToolExecutionResult>
	> = Object.create(null);
	for (const registration of registrations)
		tools[registration.name] = async (args, signal) => {
			signal?.throwIfAborted();
			const position = controls.length;
			controls.push(undefined);
			const id = await toolApi.createTask(
				nestedTask,
				{ name: registration.name, arguments: copyJson(args) },
				{ ownership: { kind: "task", taskId: runtime.taskId } },
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
				const result =
					settled.state.outcome.result ??
					executionError(
						settled.state.outcome.status,
						"Nested tool did not return a result",
					);
				controls[position] = result.control;
				return result;
			} finally {
				signal?.removeEventListener("abort", cancel);
				if (cancelling !== undefined) await cancelling;
			}
		};

	return tools;
}
