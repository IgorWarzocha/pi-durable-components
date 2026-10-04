import { type Context, copyJson, type JsonValue } from "@earendil-works/chord";
import { withAbortSignal, withCancel } from "@earendil-works/chord/context";
import {
	type Agent,
	defineDocFamily,
	defineExtension,
	defineTask,
	type Harness,
	type JsonObject,
	type TaskId,
	type ToolControl,
	type ToolExecutionApi,
	type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import type {
	CellEngine,
	CellEngineApi,
	CellObservation,
} from "./cell-contract.ts";
import { combineControls } from "./controls.ts";
import {
	createInvocation,
	errorText,
	executionError,
	InvocationDoc,
	type InvocationState,
	storeResult,
} from "./invocation.ts";
import { createNestedToolTask } from "./nested.ts";
import { providerProjection } from "./projection.ts";

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

/** Task documents retire on settlement. Completed cells retain driver snapshots here. */
const CellStateDoc = defineDocFamily<InvocationState, null>({
	kind: "howaboua.execution.cells",
	family: true,
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ result: {} }),
});

function assertSingleExecutionMode(agent: Agent): void {
	const modes = agent.extensions.filter((extension) =>
		extension.tasks?.some((task) =>
			task.definition.name.startsWith("howaboua.execution.cell."),
		),
	);
	if (modes.length > 1)
		throw new Error(
			`Select exactly one execution mode with conversation.configure({ extensions: [...] }). Selected: ${modes.map((mode) => mode.name).join(", ")}`,
		);
}

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

export function createCellCoordinator(options: CellCoordinatorOptions) {
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
	const nestedTask = createNestedToolTask(
		`howaboua.execution.nested-tool.${options.name}`,
	);
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
					const tools: Record<
						string,
						(
							args: JsonValue,
							signal?: AbortSignal,
						) => Promise<ToolExecutionResult>
					> = Object.create(null);
					const toolApi = await invocation.executionApi();
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
								cancelling ??= options.cancelTask(id, cellContext);
								cancelling.catch((error) => {
									if (!runtime.signal.aborted) runtime.report(error);
								});
							};
							signal?.addEventListener("abort", cancel, { once: true });
							if (signal?.aborted) cancel();
							try {
								const settled = await runtime.waitForTask(id, cellContext);
								if (cancelling !== undefined) await cancelling;
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
							}
						};
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
	const extension = defineExtension({
		name: options.name,
		tasks: [task, nestedTask],
		hooks: [providerProjection(options.surfaceTools)],
	});

	async function observe(
		id: TaskId<ToolExecutionResult>,
		api: ToolExecutionApi,
		context: Context,
	): Promise<CellObservation> {
		const record = await api.getTask(id, context);
		if (
			record === undefined ||
			record.kind !== task.definition.name ||
			record.conversationId !== api.conversationId
		)
			throw new Error(`Unknown cell ${id}`);
		const doc =
			(await api.snapshot(InvocationDoc, id, context)) ??
			(await api.snapshot(
				CellStateDoc,
				api.conversationId,
				String(id),
				context,
			));
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
	return {
		extension,
		async start(
			input: JsonObject,
			api: ToolExecutionApi,
			context: Context,
		): Promise<TaskId<ToolExecutionResult>> {
			if (closed) throw new Error("Execution host is closed");
			assertSingleExecutionMode(await api.agent(context));
			// Foreground, conversation owned. Check and create atomically so parallel exec calls cannot overlap.
			const copied = copyJson(input) as JsonObject;
			return api.commit(async (tx) => {
				for (const status of [
					"pending",
					"running",
					"waiting",
					"completing",
				] as const) {
					const live = await tx.scanTasks(
						{
							conversationId: api.conversationId,
							kind: task.definition.name,
							status,
						},
						1,
					);
					if (live.items.length > 0)
						throw new Error(
							`Cell ${live.items[0]?.id} is still running. Wait or terminate it before starting another cell`,
						);
				}
				return tx.createTask(task, copied, {
					ownership: { kind: "conversation" },
				});
			}, context);
		},
		async wait(
			id: TaskId<ToolExecutionResult>,
			api: ToolExecutionApi,
			context: Context,
			yieldTimeMs = 10000,
		): Promise<CellObservation> {
			if (!Number.isFinite(yieldTimeMs) || yieldTimeMs < 0)
				throw new Error("yieldTimeMs must be non-negative and finite");
			const initial = await observe(id, api, context);
			if (initial.status !== "running" || yieldTimeMs === 0) return initial;
			const yielding = yieldState(id);
			if (yielding.yielded) {
				yielding.yielded = false;
				return initial;
			}
			const wait = withCancel(context);
			const timeout = new Error("Cell observation yielded");
			const timer = setTimeout(
				() => wait.cancel(timeout),
				Math.min(yieldTimeMs, 2_147_483_647),
			);
			try {
				await Promise.race([
					api.waitForTask(id, wait.context),
					yielding.wake.promise,
				]);
				yielding.yielded = false;
			} catch (error) {
				if (wait.context.abortSignal?.reason !== timeout) throw error;
			} finally {
				clearTimeout(timer);
				wait.cancel();
			}
			return observe(id, api, context);
		},
		async cancel(
			id: TaskId<ToolExecutionResult>,
			api: ToolExecutionApi,
			context: Context,
		): Promise<CellObservation> {
			await observe(id, api, context);
			await options.cancelTask(id, context);
			await api.waitForTask(id, context);
			return observe(id, api, context);
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
