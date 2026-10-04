import { type Context, copyJson } from "@earendil-works/chord";
import type { CellEngineApi } from "../../execution/src/cell-contract.ts";
import { readToolContract, toolValue } from "../../execution/src/index.ts";
import type { CodeCellOutput } from "./cell-output.ts";
import type { RuntimeTool } from "./runtime-contract.ts";

/** Adapt ordinary registrations and their full results at the native delegate boundary. */
export function runtimeTools(
	api: CellEngineApi,
	contracts: ReturnType<typeof readToolContract>[],
	observation: CodeCellOutput,
	context: Context,
): RuntimeTool[] {
	const publish = () => api.publish(observation.result(), context);
	const tools: RuntimeTool[] = api.registrations.map((registration, index) => ({
		name: registration.name,
		description: contracts[index]?.help ?? registration.description,
		inputSchema: contracts[index]?.inputSchema ?? registration.parameters,
		invoke: async (input, signal, callId) => {
			signal.throwIfAborted();
			const invoke = api.tools[registration.name];
			if (!invoke) throw new Error(`Tool ${registration.name} is unavailable`);
			// Preserve raw input so ordinary argument preparation runs before schema validation.
			const argumentsValue = copyJson(input ?? {});
			const trace = observation.trace(
				callId,
				registration.name,
				argumentsValue,
			);
			await publish();
			try {
				const value = await invoke(argumentsValue, signal);
				signal.throwIfAborted();
				const projected = toolValue(value);
				trace.done(value);
				await publish();
				return projected;
			} catch (error) {
				trace.failed(error);
				if (!api.signal.aborted) await publish();
				throw error;
			}
		},
	}));

	return tools;
}
