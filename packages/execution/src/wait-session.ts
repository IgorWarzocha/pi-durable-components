// Adapted from Pi Stuff 84bd5bce public-tools.ts, MIT. See ../NOTICE.
import type { Context } from "@earendil-works/chord";
import { withoutAbortSignal } from "@earendil-works/chord/context";
import type {
	TaskId,
	ToolExecutionApi,
	ToolExecutionResult,
} from "@earendil-works/pi-durable";
import type {
	CellCoordinatorOptions,
	CellObservation,
} from "./cell-contract.ts";
import { executionError } from "./invocation.ts";
import { readStoredResult } from "./invocation-state.ts";
import type { createNestedToolTask } from "./nested.ts";
import { readToolContract } from "./tool-contract.ts";
import { toolValue } from "./tool-value.ts";

/** Poll a mistaken shell handle through the selected registration, never by shell internals. */
export async function recoverWaitSession(
	cellId: TaskId<ToolExecutionResult>,
	yieldTimeMs: number,
	maxTokens: number,
	api: ToolExecutionApi,
	context: Context,
	nestedTask: ReturnType<typeof createNestedToolTask>,
	cancelTask: CellCoordinatorOptions["cancelTask"],
): Promise<CellObservation | undefined> {
	if (!Number.isSafeInteger(cellId) || cellId < 0) return undefined;
	const registration = (await api.agent(context)).callable.find(
		(tool) => tool.name === "write_stdin" && !readToolContract(tool).nativeOnly,
	);
	if (!registration) return undefined;
	const id = await api.createTask(
		nestedTask,
		{
			name: registration.name,
			arguments: {
				session_id: cellId,
				yield_time_ms: yieldTimeMs,
				max_output_tokens: maxTokens,
			},
			parent: { taskId: api.taskId, callId: api.callId },
		},
		{
			ownership: { kind: "task", taskId: api.taskId },
			abandonOnRestart: false,
		},
		context,
	);
	let cancelling: ReturnType<typeof cancelTask> | undefined;
	const abort = () => {
		cancelling ??= cancelTask(id, withoutAbortSignal(context));
		// Joined below. Avoid an unhandled rejection while the interrupted wait unwinds.
		void cancelling.catch(() => {});
	};
	context.abortSignal?.addEventListener("abort", abort, { once: true });
	if (context.abortSignal?.aborted) abort();
	try {
		const settled = await api.waitForTask(id, context);
		const result = readStoredResult(
			settled.state.outcome.result ??
				executionError(
					settled.state.outcome.status,
					"Shell continuation did not return a result",
				),
		);
		let value: unknown;
		try {
			value = toolValue(result);
		} catch (error) {
			if (
				error instanceof Error &&
				/unknown(?: or expired)? process id/i.test(error.message)
			)
				return undefined;
			throw error;
		}
		if (!value || typeof value !== "object" || !("output" in value))
			return undefined;
		const output = typeof value.output === "string" ? value.output : "";
		const running =
			"session_id" in value && typeof value.session_id === "number";
		const exitCode =
			"exit_code" in value && typeof value.exit_code === "number"
				? value.exit_code
				: undefined;
		return {
			cellId,
			status: "completed",
			recoveredSession: true,
			result: {
				...result,
				output: [
					{
						type: "text",
						text: `Recovered wait cell_id ${cellId} as exec_command session_id ${cellId} and continued it with write_stdin`,
					},
					...(output ? [{ type: "text" as const, text: output }] : []),
					...(exitCode === undefined
						? []
						: [
								{
									type: "text" as const,
									text: `Process exited with code ${exitCode}`,
								},
							]),
					...(running
						? [
								{
									type: "text" as const,
									text: `Session ${cellId} still running. Resume with write_stdin; set yield_time_ms near expected completion and lengthen later waits`,
								},
							]
						: []),
				],
			},
		};
	} finally {
		context.abortSignal?.removeEventListener("abort", abort);
		if (cancelling) await cancelling;
	}
}
