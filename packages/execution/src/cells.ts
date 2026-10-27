import { type Context, copyJson } from "@earendil-works/chord";
import { withCancel } from "@earendil-works/chord/context";
import {
	type Agent,
	defineExtension,
	type Harness,
	type JsonObject,
	type TaskId,
	type ToolExecutionApi,
	type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import type {
	CellCoordinatorOptions,
	CellObservation,
} from "./cell-contract.ts";
import { observeCell } from "./cell-observation.ts";
import { observeCellProgress } from "./cell-progress.ts";
import { createCellTask } from "./cell-task.ts";
import { forwardingHook } from "./forwarding-hook.ts";
import { InvocationDoc } from "./invocation-state.ts";
import { createNestedToolTask } from "./nested.ts";
import { providerProjection } from "./projection.ts";
import { ToolOriginDoc } from "./tool-origin.ts";
import { recoverWaitSession } from "./wait-session.ts";

export type { CellCoordinatorOptions } from "./cell-contract.ts";

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

export function createCellCoordinator(options: CellCoordinatorOptions) {
	const nestedTask = createNestedToolTask(
		`howaboua.execution.nested-tool.${options.name}`,
	);
	const driver = createCellTask(options, nestedTask);
	const task = driver.task;
	const projection = providerProjection(options.surfaceTools);
	const forwarding = forwardingHook();
	const extension = defineExtension({
		name: options.name,
		tasks: [task, nestedTask],
		hooks: [projection.hook, forwarding.hook],
	});

	return {
		extension,
		/** Shared nested dispatch for guest handlers owned by an ordinary tool task. */
		nestedTask,
		bind(harness: Pick<Harness, "conversation">) {
			projection.bind(harness);
			forwarding.bind(harness);
		},
		async start(
			input: JsonObject,
			api: ToolExecutionApi,
			context: Context,
		): Promise<TaskId<ToolExecutionResult>> {
			if (driver.closed) throw new Error("Execution host is closed");
			assertSingleExecutionMode(await api.agent(context));
			// Reserve lanes atomically, including kernels still starting or settling.
			const copied = copyJson(input) as JsonObject;
			return api.commit(async (tx) => {
				const isolatedLimit = options.isolatedConcurrency ?? 0;
				const isolated = isolatedLimit > 0 && input["isolated"] === true;
				let isolatedCount = 0;
				let normalCount = 0;
				let activeCount = 0;
				for (const status of [
					"pending",
					"running",
					"waiting",
					"sleeping",
					"completing",
				] as const) {
					const live = await tx.scanTasks(
						{
							conversationId: api.conversationId,
							kind: task.definition.name,
							status,
						},
						Math.max(
							isolatedLimit + (options.normalQueueLimit ?? 1),
							options.activeCellLimit ?? 1,
						),
					);
					for (const cell of live.items) {
						activeCount++;
						if ((await tx.doc(InvocationDoc, cell.id)).isolated)
							isolatedCount++;
						else if (
							!isolated &&
							++normalCount >= (options.normalQueueLimit ?? 1)
						)
							throw new Error(
								`Cell ${cell.id} is still running. Wait or terminate it before starting another cell`,
							);
					}
				}
				if (
					options.activeCellLimit !== undefined &&
					activeCount >= options.activeCellLimit
				)
					throw new Error(
						`Execution allows ${options.activeCellLimit} active cells at a time; wait for or terminate an earlier cell`,
					);
				if (isolated && isolatedCount >= isolatedLimit)
					throw new Error(
						`Notebook allows ${options.isolatedConcurrency} isolated cells at a time; wait for or terminate an isolated cell first`,
					);
				const id = await tx.createTask(task, copied, {
					ownership: { kind: "conversation" },
				});
				const doc = await tx.doc(InvocationDoc, id);
				if (isolated) doc.isolated = true;
				doc.forwardingCellId = id;
				doc.forwardingBudget =
					typeof input["max_output_tokens"] === "number"
						? input["max_output_tokens"] * 4
						: 40000;
				doc.forwardedToolCalls = {
					version: 1,
					cellId: String(id),
					calls: [],
					omittedCalls: 0,
				};
				const inherited = await tx.doc(ToolOriginDoc, api.taskId);
				(await tx.doc(ToolOriginDoc, id)).origin = inherited.origin ?? {
					conversationId: api.conversationId,
					taskId: api.taskId,
					callId: api.callId,
				};
				return id;
			}, context);
		},
		async wait(
			id: TaskId<ToolExecutionResult>,
			api: ToolExecutionApi,
			context: Context,
			yieldTimeMs = 10000,
			maxTokens = 10000,
			sessionYieldTimeMs = yieldTimeMs,
		): Promise<CellObservation> {
			if (!Number.isFinite(yieldTimeMs) || yieldTimeMs < 0)
				throw new Error("yieldTimeMs must be non-negative and finite");
			const record = await api.getTask(id, context);
			if (
				record === undefined ||
				record.kind !== task.definition.name ||
				record.conversationId !== api.conversationId
			) {
				const recovered = await recoverWaitSession(
					id,
					sessionYieldTimeMs,
					maxTokens,
					api,
					context,
					nestedTask,
					options.cancelTask,
				);
				if (recovered) return recovered;
			}
			const initial = await observeCell(
				task.definition.name,
				id,
				api,
				context,
				maxTokens * 4,
			);
			const stopProgress = await observeCellProgress(
				id,
				api,
				context,
				maxTokens * 4,
			);
			try {
				if (initial.status !== "running" || yieldTimeMs === 0) return initial;
				// A resumed cell's new nested calls belong to this live observer admission,
				// not the retired exec slot. createInvocation snapshots this at child creation.
				await api.commit(async (tx) => {
					const inherited = (await tx.doc(ToolOriginDoc, api.taskId)).origin;
					(await tx.doc(ToolOriginDoc, id)).origin = inherited ?? {
						conversationId: api.conversationId,
						taskId: api.taskId,
						callId: api.callId,
					};
				}, context);
				const yielding = driver.observeYield(id);
				if (yielding.consume()) {
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
						yielding.wake,
					]);
					yielding.consume();
				} catch (error) {
					if (wait.context.abortSignal?.reason !== timeout) throw error;
				} finally {
					clearTimeout(timer);
					wait.cancel();
				}
				return observeCell(
					task.definition.name,
					id,
					api,
					context,
					maxTokens * 4,
				);
			} finally {
				await stopProgress();
			}
		},
		async cancel(
			id: TaskId<ToolExecutionResult>,
			api: ToolExecutionApi,
			context: Context,
			maxTokens = 10000,
		): Promise<CellObservation> {
			await observeCell(task.definition.name, id, api, context);
			const stopProgress = await observeCellProgress(
				id,
				api,
				context,
				maxTokens * 4,
			);
			try {
				await options.cancelTask(id, context);
				await api.waitForTask(id, context);
				return observeCell(
					task.definition.name,
					id,
					api,
					context,
					maxTokens * 4,
				);
			} finally {
				await stopProgress();
			}
		},

		close: driver.close,
	};
}
