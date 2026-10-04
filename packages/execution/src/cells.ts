import { type Context, copyJson } from "@earendil-works/chord";
import { withCancel } from "@earendil-works/chord/context";
import {
	type Agent,
	defineExtension,
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
import { createCellTask } from "./cell-task.ts";
import { createNestedToolTask } from "./nested.ts";
import { providerProjection } from "./projection.ts";

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
	const extension = defineExtension({
		name: options.name,
		tasks: [task, nestedTask],
		hooks: [projection.hook],
	});

	return {
		extension,
		bind: projection.bind,
		async start(
			input: JsonObject,
			api: ToolExecutionApi,
			context: Context,
		): Promise<TaskId<ToolExecutionResult>> {
			if (driver.closed) throw new Error("Execution host is closed");
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
			const initial = await observeCell(task.definition.name, id, api, context);
			if (initial.status !== "running" || yieldTimeMs === 0) return initial;
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
				await Promise.race([api.waitForTask(id, wait.context), yielding.wake]);
				yielding.consume();
			} catch (error) {
				if (wait.context.abortSignal?.reason !== timeout) throw error;
			} finally {
				clearTimeout(timer);
				wait.cancel();
			}
			return observeCell(task.definition.name, id, api, context);
		},
		async cancel(
			id: TaskId<ToolExecutionResult>,
			api: ToolExecutionApi,
			context: Context,
		): Promise<CellObservation> {
			await observeCell(task.definition.name, id, api, context);
			await options.cancelTask(id, context);
			await api.waitForTask(id, context);
			return observeCell(task.definition.name, id, api, context);
		},

		close: driver.close,
	};
}
