import { copyJson } from "@earendil-works/chord";
import { withAbortSignal } from "@earendil-works/chord/context";
import {
	defineTask,
	type JsonObject,
	type TaskId,
	type ToolControl,
	type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import type { CellCoordinatorOptions, CellEngineApi } from "./cell-contract.ts";
import { CellStateDoc } from "./cell-observation.ts";
import { cellTools } from "./cell-tools.ts";
import { combineControls } from "./controls.ts";
import {
	createInvocation,
	errorText,
	executionError,
	InvocationDoc,
	storeResult,
} from "./invocation.ts";
import { createNestedToolTask } from "./nested.ts";

function yieldSignal() {
	let resolve!: () => void;
	const promise = new Promise<void>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
}

type YieldState = { yielded: boolean; wake: ReturnType<typeof yieldSignal> };
type ActiveCell = {
	controller: AbortController;
	done: ReturnType<typeof yieldSignal>;
};

/** Own the durable cell phases and the process-local driver lifetime together. */
export function createCellTask(
	options: CellCoordinatorOptions,
	nestedTask: ReturnType<typeof createNestedToolTask>,
) {
	let closed = false;
	let closing: Promise<void> | undefined;
	const active = new Map<TaskId, ActiveCell>();
	const yields = new Map<TaskId, YieldState>();
	const yieldState = (id: TaskId) => {
		let state = yields.get(id);
		if (state === undefined) {
			state = { yielded: false, wake: yieldSignal() };
			yields.set(id, state);
		}
		return state;
	};

	const excluded = new Set(options.surfaceTools);
	const task = defineTask<
		JsonObject,
		{ phase: "start" } | { phase: "execute" },
		ToolExecutionResult,
		Record<string, never>
	>({
		name: `howaboua.execution.cell.${options.name}`,
		version: 1,
		initial: () => ({ phase: "start" }),
		phases: {
			start: async (record, runtime, context) => {
				await runtime.commit(async (tx) => {
					await tx.doc(InvocationDoc, runtime.taskId);
					return { status: "running", checkpoint: { phase: "execute" } };
				}, context);
				const controller = new AbortController();
				const running: ActiveCell = { controller, done: yieldSignal() };
				const yielding = yieldState(runtime.taskId);
				active.set(runtime.taskId, running);
				const signal = AbortSignal.any([runtime.signal, controller.signal]);
				const cellContext = withAbortSignal(signal, context);
				let invocation:
					| Awaited<ReturnType<typeof createInvocation>>
					| undefined;
				let ending: "completed" | "failed" = "completed";
				let result: ToolExecutionResult;
				const controls: (ToolControl | undefined)[] = [];
				try {
					if (closed) throw new Error("Execution host is closed");
					invocation = createInvocation(runtime, {}, cellContext);
					const registrations = (await runtime.agent(cellContext)).tools.filter(
						(tool) => !excluded.has(tool.name),
					);
					const toolApi = await invocation.executionApi();
					const tools = cellTools(
						runtime,
						toolApi,
						registrations,
						nestedTask,
						controls,
						options.cancelTask,
						cellContext,
					);
					const api: CellEngineApi = {
						taskId: runtime.taskId,
						conversationId: runtime.conversationId,
						signal,
						toolApi,
						registrations,
						tools,
						publish: async (value, publishContext) => {
							const result = storeResult(value);
							await runtime.commit(async (tx) => {
								(await tx.doc(InvocationDoc, runtime.taskId)).result = result;
								return undefined;
							}, publishContext);
						},
						requestYield: async (yieldContext) => {
							await runtime.commit(async (tx) => {
								const doc = await tx.doc(InvocationDoc, runtime.taskId);
								doc.yieldCount = (doc.yieldCount ?? 0) + 1;
								return undefined;
							}, yieldContext);
							yielding.yielded = true;
							yielding.wake.resolve();
							yielding.wake = yieldSignal();
						},
						checkpoint: async (value, checkpointContext) => {
							const checkpoint = copyJson(value);
							await runtime.commit(async (tx) => {
								(await tx.doc(InvocationDoc, runtime.taskId)).checkpoint =
									checkpoint;
								return undefined;
							}, checkpointContext);
						},
					};
					result = await options.engine.run(record.input, api, cellContext);
					signal.throwIfAborted();
				} catch (error) {
					if (runtime.signal.aborted) {
						await invocation?.stop(error);
						throw error;
					}
					const partial = await runtime.snapshot(
						InvocationDoc,
						runtime.taskId,
						context,
					);
					result = {
						...(partial?.result ?? {}),
						isError: true,
						diagnostics: [
							...(partial?.result.diagnostics ?? []),
							{
								severity: "error",
								code: "cell_error",
								message: errorText(error),
							},
						],
					};
					ending = "failed";
				} finally {
					if (runtime.signal.aborted) {
						active.delete(runtime.taskId);
						yields.delete(runtime.taskId);
						running.done.resolve();
					}
				}
				const finished = await invocation?.finish(result);
				const finalResult = finished?.result ?? result;
				const control = combineControls([...controls, finalResult.control]);
				const final =
					control === undefined ? finalResult : { ...finalResult, control };
				try {
					await runtime.commit(async (tx) => {
						(await tx.doc(InvocationDoc, runtime.taskId)).result =
							storeResult(final);
						Object.assign(
							await tx.doc(
								CellStateDoc,
								runtime.conversationId,
								String(runtime.taskId),
								null,
							),
							await tx.doc(InvocationDoc, runtime.taskId),
						);
						return {
							status: "terminal",
							outcome:
								ending === "completed"
									? { status: "completed", result: final }
									: {
											status: "failed",
											error: { message: "Cell execution failed" },
											result: final,
										},
						};
					}, context);
					for (const waiter of finished?.pending ?? []) waiter.resolve();
				} catch (error) {
					for (const waiter of finished?.pending ?? []) waiter.reject(error);
					throw error;
				} finally {
					active.delete(runtime.taskId);
					yields.delete(runtime.taskId);
					running.done.resolve();
				}
			},
			execute: async (_record, runtime, context) => {
				await runtime.commit(async (tx) => {
					const doc = await tx.doc(InvocationDoc, runtime.taskId);
					const error = executionError(
						"interrupted",
						"Cell was interrupted and may have partially run. Code was not replayed",
					);
					const result: ToolExecutionResult = {
						...doc.result,
						isError: true,
						diagnostics: [
							...(doc.result.diagnostics ?? []),
							...(error.diagnostics ?? []),
						],
					};
					doc.result = storeResult(result);
					Object.assign(
						await tx.doc(
							CellStateDoc,
							runtime.conversationId,
							String(runtime.taskId),
							null,
						),
						doc,
					);
					return {
						status: "terminal",
						outcome: {
							status: "failed",
							error: { message: "Cell was interrupted" },
							result,
						},
					};
				}, context);
			},
		},
		abort: async (_record, runtime, context) => {
			await runtime.commit(async (tx) => {
				const doc = await tx.doc(InvocationDoc, runtime.taskId);
				const error = executionError("aborted", "Cell was aborted");
				const result: ToolExecutionResult = {
					...doc.result,
					isError: true,
					diagnostics: [
						...(doc.result.diagnostics ?? []),
						...(error.diagnostics ?? []),
					],
				};
				doc.result = storeResult(result);
				Object.assign(
					await tx.doc(
						CellStateDoc,
						runtime.conversationId,
						String(runtime.taskId),
						null,
					),
					doc,
				);
				return { status: "terminal", outcome: { status: "aborted", result } };
			}, context);
		},
	});

	return {
		task,
		get closed(): boolean {
			return closed;
		},
		observeYield(id: TaskId) {
			const yielding = yieldState(id);
			return {
				wake: yielding.wake.promise,
				consume(): boolean {
					const yielded = yielding.yielded;
					yielding.yielded = false;
					return yielded;
				},
			};
		},
		close(): Promise<void> {
			if (closing !== undefined) return closing;
			closed = true;
			const invocations = [...active.values()];
			for (const running of invocations)
				running.controller.abort(new Error("Execution host closed"));
			closing = Promise.all([
				options.engine.close(),
				...invocations.map((running) => running.done.promise),
			]).then(() => undefined);
			return closing;
		},
	};
}
