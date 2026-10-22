import type { Context } from "@earendil-works/chord";
import {
	defineTool,
	type TaskId,
	type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { pulseAuthoring } from "./authoring.ts";
import type { PulseRunRequest, PulsesOptions } from "./contract.ts";
import type { PulseCatalogItem } from "./definitions.ts";

export function createPulsesTool(
	options: PulsesOptions,
	operations: {
		catalog(context: Context, bindingKey: string): Promise<PulseCatalogItem[]>;
		run(
			request: PulseRunRequest,
			context: Context,
			api: ToolExecutionApi,
		): Promise<TaskId | undefined>;
	},
) {
	const registration = defineTool({
		name: "pulses",
		description: "Run a saved routine",
		parameters: Type.Object(
			{
				run: Type.Optional(Type.String({ minLength: 1 })),
				skill: Type.Optional(Type.Literal(true)),
			},
			{ additionalProperties: false },
		),
		replay: "safe",
		executionMode: "sequential",
		outputLimits: {
			maxBytes: Number.MAX_SAFE_INTEGER,
			maxLines: Number.MAX_SAFE_INTEGER,
		},
		async execute(args, api, context) {
			if (args.run !== undefined && args.skill !== undefined)
				throw new Error("Supply run or skill, not both.");
			if (args.run !== undefined && !/^[a-z0-9][a-z0-9-]*$/u.test(args.run))
				throw new Error(
					"Use a pulse folder name. Call pulses with no arguments to see valid paths.",
				);
			context.abortSignal?.throwIfAborted();
			if (args.skill)
				return { output: [{ type: "text", text: pulseAuthoring }] };
			// Freeze routing before admission. Recovery must rejoin the admitted request
			// even if the host mapping or definition has since disappeared.
			let route = args.run
				? await api.memo<{ bindingKey: string }>("pulse-route", context)
				: undefined;
			if (!route) {
				if (!api.env)
					throw new Error(
						"Pulses requires the conversation's execution environment",
					);
				if (!options.resolveToolBinding)
					throw new Error(
						"Pulses tools require a host-provided conversation binding",
					);
				const bindingKey = await options.resolveToolBinding(api, context);
				if (!bindingKey.trim()) throw new Error("Missing pulse binding key");
				route = args.run
					? await api.memo("pulse-route", { bindingKey }, context)
					: { bindingKey };
			}
			let text: string;
			if (args.run !== undefined) {
				const taskId = await operations.run(
					{
						bindingKey: route.bindingKey,
						pulseId: args.run,
						requestId: `tool:${api.taskId}`,
					},
					context,
					api,
				);
				text =
					taskId === undefined
						? "Not admitted: the pulse is busy, capacity is occupied or admission is held. No new run was requested."
						: `Requested pulses/${args.run}/PULSE.md. Native task: ${taskId}. Admission is not completion. Child results are passive context; resident work reports in its conversation.`;
			} else {
				const items = await operations.catalog(context, route.bindingKey);
				text = [
					'Run: {run:"check-new-issues"}; authoring: {skill:true}',
					...items
						.filter((item) => item.status === "valid")
						.map((item) => item.path),
					...items
						.filter((item) => item.status === "invalid")
						.map((item) => `${item.path} (invalid: ${item.error})`),
				].join("\n");
			}
			return { output: [{ type: "text", text }] };
		},
	});
	return { ...registration, executionHints: { discovery: "help" as const } };
}
