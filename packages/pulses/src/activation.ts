import {
	type ComponentInstance,
	type ComponentRequest,
	defineCapability,
	isCapabilityObject,
	type ScheduledWork,
	schedulingCapability,
} from "@howaboua/pi-durable-components";
import type { PulsesOptions } from "./contract.ts";
import type { PulseDefinition } from "./definitions.ts";
import { createPulses } from "./index.ts";

function scheduledWork(definition: PulseDefinition): ScheduledWork {
	const { pulseHome, status: _status, ...work } = definition;
	return { ...work, home: pulseHome };
}

function configuredOptions(request: ComponentRequest): PulsesOptions {
	const grant = request.capabilities.get(schedulingCapability);
	const resolveToolBinding = grant.resolveToolBinding?.bind(grant);
	const withToolRunAuthorization = grant.withToolRunAuthorization?.bind(grant);
	const authorizeTransaction = grant.authorizeTransaction?.bind(grant);
	const submitInput = grant.submitInput?.bind(grant);
	const writeResult = grant.writeResult?.bind(grant);
	const concurrency = request.configuration["concurrency"];
	if (concurrency !== undefined && typeof concurrency !== "number")
		throw new Error("Pulses configuration.concurrency must be a number");
	return {
		...(concurrency === undefined ? {} : { concurrency }),
		getBindings: (context) => grant.bindings(context),
		readDefinitions: (binding, context) =>
			grant.readDefinitions(
				binding,
				{ directory: "pulses", fileName: "PULSE.md" },
				context,
			),
		admit: (binding, definition, trigger, context) =>
			grant.authorize(binding, scheduledWork(definition), trigger, context),
		configure: (tx, conversationId, binding, definition, creation) =>
			grant.configure(
				tx,
				conversationId,
				binding,
				scheduledWork(definition),
				creation,
			),
		onError: (error) => grant.onError(error),
		...(resolveToolBinding === undefined ? {} : { resolveToolBinding }),
		...(withToolRunAuthorization === undefined
			? {}
			: {
					withToolRunAuthorization: (api, input, run, context) =>
						withToolRunAuthorization(
							api,
							{
								bindingKey: input.bindingKey,
								workId: input.pulseId,
								requestId: input.requestId,
							},
							run,
							context,
						),
				}),
		...(authorizeTransaction === undefined
			? {}
			: {
					admitTransaction: (tx, admission, context) => {
						const { definition, ...rest } = admission;
						return authorizeTransaction(
							tx,
							{ ...rest, work: scheduledWork(definition) },
							context,
						);
					},
				}),
		...(submitInput === undefined ? {} : { submitInput }),
		...(writeResult === undefined ? {} : { writeResult }),
	};
}

export const pulsesOptions = defineCapability<PulsesOptions>(
	"howaboua.pulses.options.v1",
	(value): value is PulsesOptions =>
		isCapabilityObject(value) &&
		["getBindings", "readDefinitions", "admit", "configure", "onError"].every(
			(name) => typeof value[name] === "function",
		) &&
		[
			"resolveToolBinding",
			"withToolRunAuthorization",
			"admitTransaction",
			"submitInput",
			"writeResult",
		].every(
			(name) => value[name] === undefined || typeof value[name] === "function",
		) &&
		(value["concurrency"] === undefined ||
			typeof value["concurrency"] === "number"),
);

export function createComponent(
	request: ComponentRequest,
): ComponentInstance<ReturnType<typeof createPulses>> {
	const api = createPulses(
		request.capabilities.has(pulsesOptions.id)
			? request.capabilities.get(pulsesOptions)
			: configuredOptions(request),
	);
	let stopped = false;
	const stopAdmission = async () => {
		stopped = true;
		await api.stopAdmission();
	};
	return {
		extensions: [api.extension],
		api,
		retention: "harness",
		bind: ({ harness }, context) => api.bind(harness, context),
		stopAdmission,
		beforeClose: stopAdmission,
		afterClose: () => api.unbind(),
		maintain: (context) => (stopped ? undefined : api.scan(context)),
	};
}
