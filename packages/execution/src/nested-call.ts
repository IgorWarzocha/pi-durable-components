import type { JsonValue } from "@earendil-works/chord";
import type { ToolCall } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import {
	type Agent,
	type HookApi,
	type JsonObject,
	type TaskId,
	type TaskRuntime,
	type ToolExecutionResult,
	type ToolHookCall,
	type ToolHooks,
	type ToolRegistration,
	ToolTask,
} from "@earendil-works/pi-durable";
export type NestedInput = {
	name: string;
	arguments: JsonValue;
	cellId?: TaskId;
	parent?: NonNullable<ToolHookCall["parent"]>;
};
export type Checkpoint =
	| { phase: "call" }
	| { phase: "execute"; arguments: JsonObject; replay: "safe" | "unsafe" };
export type Runtime = TaskRuntime<
	NestedInput,
	Checkpoint,
	ToolExecutionResult,
	Record<string, never>
>;

export function nestedCall(runtime: Runtime, input: NestedInput): ToolHookCall {
	const args = input.arguments;
	return {
		type: "toolCall",
		id: `nested-${runtime.taskId}`,
		name: input.name,
		...(input.parent === undefined ? {} : { parent: input.parent }),
		arguments:
			args !== null && typeof args === "object" && !Array.isArray(args)
				? args
				: {},
	};
}

export function checked(
	tool: ToolRegistration,
	call: ToolCall,
	args: unknown,
): JsonObject {
	return validateToolArguments(tool, {
		...call,
		arguments: args as JsonObject,
	}) as JsonObject;
}

/** Public hook registrations erase their handler type. Select by the built-in task name before restoring it. */
export async function eachHook<K extends keyof ToolHooks>(
	agent: Agent,
	name: K,
	api: HookApi & { signal: AbortSignal; report(error: unknown): void },
	invoke: (hook: ToolHooks[K]) => Promise<void>,
): Promise<void> {
	for (const extension of agent.extensions)
		for (const registration of extension.hooks ?? []) {
			if (registration.task !== ToolTask.definition.name) continue;
			const handler = (registration.handlers as Partial<ToolHooks>)[name];
			if (handler === undefined) continue;
			try {
				await invoke(handler);
			} catch (error) {
				if (api.signal.aborted) throw error;
				api.report(error);
			}
		}
}
