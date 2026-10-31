import { join } from "node:path";
import type { TaskId } from "@earendil-works/pi-durable";
import {
	type ComponentBinding,
	type ComponentInput,
	type ComponentInstance,
	type ComponentRequest,
	defineCapability,
	isCapabilityObject,
	modelsCapability,
	nodeExecutionCapability,
	stateCapability,
} from "@howaboua/pi-durable-components";
import {
	type ContextModelRole,
	createContextManagement,
	type InputResult,
} from "./index.ts";
import { createNodeHistoryRanker } from "./node.ts";

type ContextOptions = Parameters<typeof createContextManagement>[0];
type Management = ReturnType<typeof createContextManagement>;

/** Optional advanced hooks. Ordinary hosts need only their shared Models grant. */
export const contextOptions = defineCapability<ContextOptions>(
	"howaboua.context.options.v1",
	(value): value is ContextOptions =>
		isCapabilityObject(value) &&
		isCapabilityObject(value["models"]) &&
		typeof value["models"]["getModel"] === "function" &&
		typeof value["models"]["getAuth"] === "function",
);

function oneOf<Value extends string | number>(
	value: unknown,
	choices: readonly Value[],
): value is Value {
	return choices.some((choice) => choice === value);
}

function configuredOptions(request: ComponentRequest): ContextOptions {
	const config = request.configuration;
	const allowed = new Set([
		"archiveHistory",
		"automaticIdleRollover",
		"idleRolloverMinutes",
		"taskBoundaryReminderTokens",
		"newContextRequests",
		"rankedHistory",
		"modelRoles",
	]);
	for (const key of Object.keys(config))
		if (!allowed.has(key))
			throw new Error(`Unknown Context configuration: ${key}`);
	const options: ContextOptions = {
		models: request.capabilities.get(modelsCapability),
	};
	for (const key of ["archiveHistory", "automaticIdleRollover"] as const) {
		const value = config[key];
		if (value !== undefined) {
			if (typeof value !== "boolean")
				throw new Error(`${key} must be a boolean`);
			options[key] = value;
		}
	}
	const idle = config["idleRolloverMinutes"];
	if (idle !== undefined) {
		if (!oneOf(idle, [0, 5, 15, 25, 55, 115, 355, 715] as const))
			throw new Error("Invalid idleRolloverMinutes");
		options.idleRolloverMinutes = idle;
	}
	const boundary = config["taskBoundaryReminderTokens"];
	if (boundary !== undefined) {
		if (
			typeof boundary !== "number" ||
			!Number.isSafeInteger(boundary) ||
			boundary < 0
		)
			throw new Error(
				"taskBoundaryReminderTokens must be a non-negative safe integer",
			);
		options.taskBoundaryReminderTokens = boundary;
	}
	const policy = config["newContextRequests"];
	if (policy !== undefined) {
		if (!oneOf(policy, ["off", "unrestricted"] as const))
			throw new Error(
				"pi-limits requires the advanced history-eligibility host signal",
			);
		options.newContextRequests = policy;
	}
	const roles = config["modelRoles"];
	if (roles !== undefined) {
		if (!Array.isArray(roles)) throw new Error("modelRoles must be an array");
		const parsed: ContextModelRole[] = [];
		for (const role of roles) {
			if (
				!isCapabilityObject(role) ||
				Object.keys(role).some(
					(key) =>
						!["id", "description", "provider", "model", "reasoning"].includes(
							key,
						),
				) ||
				typeof role["id"] !== "string" ||
				typeof role["description"] !== "string" ||
				typeof role["provider"] !== "string" ||
				typeof role["model"] !== "string" ||
				!oneOf(role["reasoning"], [
					"off",
					"minimal",
					"low",
					"medium",
					"high",
					"xhigh",
					"max",
				] as const)
			)
				throw new Error("Invalid Context model role");
			parsed.push({
				id: role["id"],
				description: role["description"],
				provider: role["provider"],
				model: role["model"],
				reasoning: role["reasoning"],
			});
		}
		options.modelRoles = () => parsed;
	}
	return options;
}

export function createComponent(
	request: ComponentRequest,
): ComponentInstance<Management> {
	const advanced = request.capabilities.has(contextOptions.id);
	const options = advanced
		? request.capabilities.get(contextOptions)
		: configuredOptions(request);
	let ranker: ReturnType<typeof createNodeHistoryRanker> | undefined;
	const ranking = request.configuration["rankedHistory"];
	if (!advanced && ranking !== undefined) {
		if (typeof ranking !== "boolean")
			throw new Error("rankedHistory must be a boolean");
		if (ranking) {
			request.capabilities.get(nodeExecutionCapability);
			const state = request.capabilities.get(stateCapability);
			ranker = createNodeHistoryRanker({
				path: join(state.directory("context"), "history.sqlite"),
			});
			options.rankedHistory = { ranker };
		}
	}
	const management = createContextManagement(options);
	let bound: ComponentBinding | undefined;
	function inputFor(
		task: TaskId<InputResult>,
		binding: ComponentBinding,
	): ComponentInput {
		return {
			taskId: task,
			waitForSubmission: (ctx) => management.waitForSubmission(task, ctx),
			async abort(ctx) {
				await binding.harness.abortTask(task, ctx);
				const stopped = await binding.harness.waitForTask(task, ctx);
				const outcome = stopped.state.outcome;
				if (outcome.status === "aborted") return "aborted";
				if (outcome.status === "completed") return "settled";
				throw new Error(
					`Managed input cancellation did not settle cleanly: ${outcome.status}`,
				);
			},
		};
	}
	return {
		extensions: [management.extension],
		api: management,
		retention: "harness",
		bind(binding) {
			management.bind(binding.harness, binding.storage);
			bound = binding;
		},
		admission: {
			extensions: [management.extension.name],
			async rejoin(conversationId, requestId, context) {
				if (!bound) throw new Error("Bind Context before looking up input");
				const binding = bound;
				const task = await management.rejoin(
					conversationId,
					requestId,
					context,
				);
				return task === undefined ? undefined : inputFor(task, binding);
			},
			async submit(conversationId, input, context) {
				if (!bound) throw new Error("Bind Context before admitting input");
				const binding = bound;
				const task = await management.submit(conversationId, input, context);
				return inputFor(task, binding);
			},
		},
		async afterClose() {
			if (bound) management.unbind(bound.harness);
			bound = undefined;
			await ranker?.close();
		},
	};
}
