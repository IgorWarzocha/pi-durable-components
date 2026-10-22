import type { Context } from "@earendil-works/chord";
import {
	defineExtension,
	type Harness,
	type TaskId,
	type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { admitted, createAdmission, validateConcurrency } from "./admission.ts";
import type { PulseRunRequest, PulsesOptions } from "./contract.ts";
import {
	type PulseCatalogItem,
	type PulseDefinition,
	parsePulseDefinition,
} from "./definitions.ts";
import { execution, type PulseExecutionRequest } from "./execution.ts";
import { explicitReady, reconcileSchedules } from "./occurrences.ts";
import { Checkpoints, pulseKey, restoreMissingReferences } from "./state.ts";
import { Anchor, createRunTask } from "./tasks.ts";
import { createPulsesTool } from "./tool.ts";

export type {
	PulseAdmission,
	PulseAdmissionDecision,
	PulseBinding,
	PulseInputDelivery,
	PulseOccurrence,
	PulseOutcome,
	PulseResultDelivery,
	PulseRunRequest,
	PulseSource,
	PulsesOptions,
	PulseTrigger,
} from "./contract.ts";
export {
	type PulseCatalogItem,
	type PulseDefinition,
	parsePulseDefinition,
} from "./definitions.ts";
export type { PulseExecutionRequest } from "./execution.ts";
export { parsePulseFrontmatter } from "./frontmatter.ts";
export { explicitReady } from "./occurrences.ts";
export {
	isPulseDue,
	isPulseQuietAt,
	type PulseQuietHours,
	type PulseSchedule,
	parsePulseQuietHours,
	parsePulseSchedule,
	pulseDueKey,
} from "./schedule.ts";
export type {
	PulseCheckpoint,
	PulseDisposition,
	PulseReference,
} from "./state.ts";
export type { PulseRunInput } from "./tasks.ts";

/** Supply the actual installed asset path mapped into the execution environment. Compatible with Skills' LoadedSkill. */
export function pulsesSkill(filePath: string, baseDir: string) {
	return {
		name: "pulses-ops",
		description: "Manage folder-owned pulses and inspect native scheduled work",
		filePath,
		baseDir,
	};
}

export function createPulses(options: PulsesOptions) {
	const initialConcurrency = validateConcurrency(options.concurrency ?? 2);
	let harness: Harness | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let accepting = false;
	let scanFlight: Promise<PulseCatalogItem[]> | undefined;
	let unsubscribeClose: (() => void) | undefined;
	let unsubscribeCommits: (() => void) | undefined;
	let bindingFlight: Promise<void> | undefined;
	let releaseScanQueued = false;
	let pending = Promise.resolve();
	const host = () => {
		if (!harness) throw new Error("Bind Pulses before use");
		return harness;
	};
	const Run = createRunTask(host, options);
	const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
		const result = pending.then(() => {
			if (!accepting)
				throw new Error("Pulses admission is not bound or has stopped");
			return work();
		});
		pending = result.then(
			() => {},
			() => {},
		);
		return result;
	};
	async function catalog(
		context: Context,
		bindingKey?: string,
	): Promise<PulseCatalogItem[]> {
		const bindings = await options.getBindings(context);
		if (
			new Set(bindings.map((binding) => binding.key)).size !== bindings.length
		)
			throw new Error("Duplicate pulse binding key");
		if (
			bindingKey !== undefined &&
			!bindings.some((binding) => binding.key === bindingKey)
		)
			throw new Error("Pulse not found");
		return (
			await Promise.all(
				bindings
					.filter(
						(binding) => bindingKey === undefined || binding.key === bindingKey,
					)
					.map(async (binding) => {
						const sources = await options.readDefinitions(binding, context);
						if (
							new Set(sources.map((source) => source.id)).size !==
							sources.length
						)
							throw new Error(`Duplicate pulse ID in ${binding.key}`);
						return sources.map((source) =>
							parsePulseDefinition(binding, source),
						);
					}),
			)
		).flat();
	}
	const dispatch = createAdmission(host, options, Run, () => accepting);
	function releaseCapacity(context: Context) {
		if (!accepting || releaseScanQueued) return;
		releaseScanQueued = true;
		// Commit listeners cannot call Session APIs. Reconcile after adoption and any current scan.
		queueMicrotask(() => {
			const rescan = () => {
				releaseScanQueued = false;
				if (accepting) return scan(context);
				return undefined;
			};
			void (scanFlight ?? Promise.resolve())
				.then(rescan, rescan)
				.catch(options.onError);
		});
	}
	function scan(context: Context): Promise<PulseCatalogItem[]> {
		if (scanFlight !== undefined) return scanFlight;
		scanFlight = exclusive(async () => {
			const definitions = await catalog(context);
			const now = Date.now();
			await host().commit(
				(tx) => reconcileSchedules(tx, definitions, now),
				context,
			);
			const checkpoints =
				(await host().snapshot(Checkpoints, context))?.pulses ?? {};
			const ready = definitions
				.filter(
					(definition): definition is PulseDefinition =>
						definition.status === "valid" &&
						definition.enabled &&
						checkpoints[pulseKey(definition.bindingKey, definition.id)]
							?.pending !== undefined,
				)
				.sort(
					(a, b) =>
						(checkpoints[pulseKey(a.bindingKey, a.id)]?.pending?.startAt ?? 0) -
						(checkpoints[pulseKey(b.bindingKey, b.id)]?.pending?.startAt ?? 0),
				);
			for (const definition of ready) {
				const checkpoint =
					checkpoints[pulseKey(definition.bindingKey, definition.id)];
				if (!checkpoint?.pending) continue;
				try {
					await dispatch(
						definition,
						"scheduled",
						`scheduled:${pulseKey(definition.bindingKey, definition.id)}:${checkpoint.trackedAt}:${checkpoint.pending.startAt}:${checkpoint.pending.endAt}`,
						context,
					);
				} catch (error) {
					options.onError(error);
				}
			}
			return definitions;
		}).finally(() => {
			scanFlight = undefined;
		});
		return scanFlight;
	}
	async function manualRun(
		request: PulseRunRequest,
		context: Context,
		api?: ToolExecutionApi,
	): Promise<TaskId | undefined> {
		if (!request.requestId.trim())
			throw new Error("A stable requestId is required");
		const requestId = `manual:${request.requestId}`;
		const rejoin = () =>
			host().commit(
				(tx) => admitted(tx, request.bindingKey, request.pulseId, requestId),
				context,
			);
		const run = () =>
			exclusive(async () => {
				const receipt = await rejoin();
				if (receipt !== undefined) return receipt;
				const definitions = await catalog(context);
				await host().commit(
					(tx) => reconcileSchedules(tx, definitions, Date.now()),
					context,
				);
				const definition = definitions.find(
					(value) =>
						value.bindingKey === request.bindingKey &&
						value.id === request.pulseId,
				);
				if (!definition) throw new Error("Pulse not found");
				if (definition.status === "invalid") throw new Error(definition.error);
				if (!definition.enabled)
					throw new Error(`Pulse is disabled: ${definition.id}`);
				return dispatch(definition, "manual", requestId, context);
			});
		if (!api || !options.withToolRunAuthorization) return run();
		if (!accepting)
			throw new Error("Pulses admission is not bound or has stopped");
		const receipt = await rejoin();
		if (receipt !== undefined) return receipt;
		// Host caller scopes may serialize UI runs too: always acquire that scope
		// before our queue. run() rejoins again before any lazy authorisation.
		return options.withToolRunAuthorization(api, { ...request }, run, context);
	}
	const tool = createPulsesTool(options, { catalog, run: manualRun });
	const component = {
		extension: defineExtension({
			name: "howaboua.pulses",
			tools: [tool],
			tasks: [Anchor, Run],
		}),
		tool,
		catalog,
		scan,
		explicitReady,
		async configuration(context: Context) {
			return {
				concurrency:
					(await host().snapshot(Checkpoints, context))?.concurrency ??
					initialConcurrency,
			};
		},
		async setConcurrency(limit: number, context: Context) {
			validateConcurrency(limit);
			return exclusive(async () => {
				await host().commit(async (tx) => {
					(await tx.doc(Checkpoints)).concurrency = limit;
				}, context);
				return { concurrency: limit };
			});
		},
		run(request: PulseRunRequest, context: Context) {
			return manualRun(request, context);
		},
		/** Native task and input receipt for the latest run of this exact job/target. No receipt means not yet submitted. */
		execution(request: PulseExecutionRequest, context: Context) {
			return host().commit((tx) => execution(tx, request), context);
		},
		async observe(context: Context) {
			const references =
				(await host().snapshot(Checkpoints, context))?.pulses ?? {};
			return Promise.all(
				Object.entries(references).map(async ([key, checkpoint]) => ({
					key,
					...checkpoint,
					task:
						checkpoint.activeTask === undefined
							? undefined
							: await host().getTask(checkpoint.activeTask, context),
				})),
			);
		},
		async stop(
			request: { bindingKey: string; pulseId: string },
			context: Context,
		) {
			return exclusive(async () => {
				const checkpoint = (await host().snapshot(Checkpoints, context))
					?.pulses[pulseKey(request.bindingKey, request.pulseId)];
				if (checkpoint?.activeTask !== undefined) {
					const task = await host().getTask(checkpoint.activeTask, context);
					if (task && task.state.status !== "terminal") {
						await host().abortTask(checkpoint.activeTask, context);
						await host().waitForTask(checkpoint.activeTask, context);
					}
				}
			});
		},
		bind(value: Harness, context: Context): Promise<void> {
			if (harness && harness !== value)
				throw new Error("Create one Pulses component per Harness");
			if (bindingFlight) return bindingFlight;
			harness = value;
			accepting = true;
			unsubscribeClose = value.subscribeClose(() => {
				accepting = false;
				if (timer) clearInterval(timer);
				timer = undefined;
				unsubscribeClose?.();
				unsubscribeClose = undefined;
				unsubscribeCommits?.();
				unsubscribeCommits = undefined;
			});
			unsubscribeCommits = value.subscribeCommits((publication) => {
				if (
					publication.changes.some(
						(change) =>
							change.type === "task" &&
							change.value.kind === "howaboua.pulses.run" &&
							change.value.state.status === "terminal",
					)
				)
					releaseCapacity(context);
			});
			timer = setInterval(() => {
				void scan(context).catch(options.onError);
			}, 300_000);
			timer.unref?.();
			bindingFlight = exclusive(() =>
				host().commit(async (tx) => {
					await restoreMissingReferences(tx);
					(await tx.doc(Checkpoints)).concurrency ??= initialConcurrency;
				}, context),
			)
				.then(() =>
					exclusive(async () => {
						const definitions = await catalog(context);
						await host().commit(
							(tx) => reconcileSchedules(tx, definitions, Date.now()),
							context,
						);
					}),
				)
				.then(() => {})
				.catch((error: unknown) => {
					accepting = false;
					if (timer) clearInterval(timer);
					timer = undefined;
					unsubscribeClose?.();
					unsubscribeClose = undefined;
					unsubscribeCommits?.();
					unsubscribeCommits = undefined;
					throw error;
				});
			// Preserve visible errors for callers that used the original non-awaited binding API.
			void bindingFlight.catch(options.onError);
			return bindingFlight;
		},
		/** Stop admission first; host must drain/close native task invocations before releasing this binding. */
		async unbind() {
			accepting = false;
			unsubscribeClose?.();
			unsubscribeClose = undefined;
			unsubscribeCommits?.();
			unsubscribeCommits = undefined;
			if (timer) clearInterval(timer);
			timer = undefined;
			await pending;
			if (bindingFlight) await bindingFlight.catch(() => {});
			bindingFlight = undefined;
			harness = undefined;
		},
	};
	return component;
}
