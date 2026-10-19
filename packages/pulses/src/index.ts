import type { Context } from "@earendil-works/chord";
import {
	type Cursor,
	defineExtension,
	type Harness,
	InboxDoc,
	LiveDoc,
	type TaskId,
	type Tx,
} from "@earendil-works/pi-durable";
import type { PulsesOptions, PulseTrigger } from "./contract.ts";
import {
	type PulseCatalogItem,
	type PulseDefinition,
	parsePulseDefinition,
} from "./definitions.ts";
import { isPulseDue, isPulseQuietAt, pulseDueKey } from "./schedule.ts";
import {
	Checkpoints,
	type PulseReference,
	pulseKey,
	restoreMissingReferences,
} from "./state.ts";
import { Anchor, createRunTask } from "./tasks.ts";

export type {
	PulseBinding,
	PulseOutcome,
	PulseResultDelivery,
	PulseSource,
	PulsesOptions,
	PulseTrigger,
} from "./contract.ts";
export {
	type PulseCatalogItem,
	type PulseDefinition,
	parsePulseDefinition,
} from "./definitions.ts";
export { parsePulseFrontmatter } from "./frontmatter.ts";
export {
	isPulseDue,
	isPulseQuietAt,
	type PulseQuietHours,
	type PulseSchedule,
	parsePulseQuietHours,
	parsePulseSchedule,
	pulseDueKey,
} from "./schedule.ts";
export type { PulseCheckpoint, PulseReference } from "./state.ts";
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

/** Native task inputs, not a second request ledger, are the idempotent admission authority. */
async function admitted(
	tx: Tx,
	bindingKey: string,
	pulseId: string,
	requestId: string,
) {
	let cursor: Cursor | undefined;
	do {
		const page = await tx.scanTasks(
			{ kind: "howaboua.pulses.run", order: "descending" },
			100,
			cursor,
		);
		for (const task of page.items) {
			const input = task.input;
			if (typeof input !== "object" || input === null || Array.isArray(input))
				continue;
			const binding = input["binding"];
			const definition = input["definition"];
			if (
				typeof binding !== "object" ||
				binding === null ||
				Array.isArray(binding) ||
				typeof definition !== "object" ||
				definition === null ||
				Array.isArray(definition)
			)
				continue;
			if (
				binding["key"] === bindingKey &&
				definition["id"] === pulseId &&
				input["requestId"] === requestId
			)
				return task.id;
		}
		cursor = page.next;
	} while (cursor !== undefined);
	return undefined;
}

/** Eligibility owns only schedule bookkeeping; native histories and admitted responsibility survive removal. */
async function reconcileSchedules(
	tx: Tx,
	definitions: readonly PulseCatalogItem[],
	now: number,
) {
	const state = await tx.doc(Checkpoints);
	const eligible = new Set<string>();
	for (const definition of definitions) {
		if (
			definition.status !== "valid" ||
			!definition.enabled ||
			definition.schedule.kind === "manual"
		)
			continue;
		const key = pulseKey(definition.bindingKey, definition.id);
		eligible.add(key);
		state.pulses[key] ??= {
			firstSeenAt: now,
			history: [],
		};
		const checkpoint = state.pulses[key];
		if (!checkpoint) throw new Error("Missing initialized pulse checkpoint");
		const scheduleKey = JSON.stringify(definition.schedule);
		if (
			!checkpoint.scheduledEligible ||
			checkpoint.scheduleKey !== scheduleKey
		) {
			checkpoint.firstSeenAt = now;
			delete checkpoint.lastRunAt;
			delete checkpoint.lastDueKey;
			const dueKey = pulseDueKey(definition.schedule, now);
			if (dueKey !== null) checkpoint.lastDueKey = dueKey;
			checkpoint.scheduledEligible = true;
			checkpoint.scheduleKey = scheduleKey;
		}
	}
	for (const [key, checkpoint] of Object.entries(state.pulses)) {
		if (eligible.has(key)) continue;
		checkpoint.scheduledEligible = false;
		delete checkpoint.lastRunAt;
		delete checkpoint.lastDueKey;
	}
}

export function createPulses(options: PulsesOptions) {
	let harness: Harness | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let accepting = false;
	let scanFlight: Promise<PulseCatalogItem[]> | undefined;
	let unsubscribeClose: (() => void) | undefined;
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
	async function catalog(context: Context): Promise<PulseCatalogItem[]> {
		const bindings = await options.getBindings(context);
		if (
			new Set(bindings.map((binding) => binding.key)).size !== bindings.length
		)
			throw new Error("Duplicate pulse binding key");
		return (
			await Promise.all(
				bindings.map(async (binding) => {
					const sources = await options.readDefinitions(binding, context);
					if (
						new Set(sources.map((source) => source.id)).size !== sources.length
					)
						throw new Error(`Duplicate pulse ID in ${binding.key}`);
					return sources.map((source) => parsePulseDefinition(binding, source));
				}),
			)
		).flat();
	}
	async function dispatch(
		definition: PulseDefinition,
		trigger: PulseTrigger,
		requestId: string,
		context: Context,
	): Promise<TaskId | undefined> {
		const receipt = await host().commit(
			(tx) => admitted(tx, definition.bindingKey, definition.id, requestId),
			context,
		);
		if (receipt !== undefined) return receipt;
		const binding = (await options.getBindings(context)).find(
			(value) => value.key === definition.bindingKey,
		);
		if (!binding || binding.root !== definition.root)
			throw new Error("Pulse binding changed; rescan before admission");
		await options.admit(binding, definition, trigger, context);
		if (!accepting) throw new Error("Pulses admission has stopped");
		const now = Date.now();
		const id = await host().commit(async (tx) => {
			const state = await tx.doc(Checkpoints);
			const key = pulseKey(binding.key, definition.id);
			const seed = pulseDueKey(definition.schedule, now);
			state.pulses[key] ??= {
				firstSeenAt: now,
				history: [],
				...(seed === null ? {} : { lastDueKey: seed }),
			};
			const checkpoint = state.pulses[key];
			if (!checkpoint) throw new Error("Missing initialized pulse checkpoint");
			const existing = await admitted(
				tx,
				binding.key,
				definition.id,
				requestId,
			);
			if (existing !== undefined) return existing;
			if (checkpoint.activeTask !== undefined) {
				const active = await tx.task(checkpoint.activeTask);
				if (!active) throw new Error("Missing pulse task");
				if (active.state.status !== "terminal") return undefined;
			}
			if (checkpoint.current) {
				const live = await tx.doc(LiveDoc, checkpoint.current.conversationId);
				const inbox = await tx.doc(InboxDoc, checkpoint.current.conversationId);
				if (live.run !== undefined || inbox.items.length > 0) return undefined;
			}
			const due = isPulseDue({
				schedule: definition.schedule,
				nowMs: now,
				firstSeenAt: checkpoint.firstSeenAt,
				lastRunAt: checkpoint.lastRunAt,
				lastDueKey: checkpoint.lastDueKey,
			});
			if (
				trigger === "scheduled" &&
				(!definition.enabled ||
					!due.due ||
					(definition.quietHours && isPulseQuietAt(definition.quietHours, now)))
			)
				return undefined;
			let reference: PulseReference;
			let created = false;
			if (
				checkpoint.current &&
				checkpoint.current.parentConversationId === binding.parentConversationId
			) {
				reference = { ...checkpoint.current };
				if (reference.root !== binding.root) {
					reference = {
						...reference,
						root: binding.root,
						pulseHome: definition.pulseHome,
					};
					checkpoint.current = reference;
					const historical = checkpoint.history.findIndex(
						(item) => item.conversationId === reference.conversationId,
					);
					if (historical < 0)
						throw new Error(
							"Missing current pulse conversation history reference",
						);
					checkpoint.history[historical] = reference;
				}
			} else {
				created = true;
				const ownership =
					binding.parentConversationId === undefined
						? { kind: "ownerless" as const }
						: {
								kind: "task" as const,
								taskId: await tx.createTask(Anchor, null, {
									ownership: { kind: "conversation" },
									conversationId: binding.parentConversationId,
									background: true,
								}),
							};
				const conversation = await tx.createConversation({ ownership });
				reference = {
					conversationId: conversation.id,
					root: binding.root,
					pulseHome: definition.pulseHome,
					...(binding.parentConversationId === undefined
						? {}
						: { parentConversationId: binding.parentConversationId }),
				};
				checkpoint.current = reference;
				checkpoint.history.push(reference);
			}
			// Refresh environment-owned local instructions for every admitted snapshot, without replacing identity.
			await options.configure(
				tx,
				reference.conversationId,
				binding,
				definition,
				{ created },
			);
			const taskId = await tx.createTask(
				Run,
				{
					binding: { ...binding },
					definition: { ...definition },
					reference,
					trigger,
					requestId,
				},
				{
					ownership: { kind: "conversation" },
					conversationId: reference.conversationId,
					background: true,
				},
			);
			checkpoint.activeTask = taskId;
			if (trigger === "scheduled") {
				checkpoint.lastRunAt = now;
				if (due.dueKey !== null) checkpoint.lastDueKey = due.dueKey;
			}
			return taskId;
		}, context);
		host().resume();
		return id;
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
			for (const definition of definitions)
				if (
					definition.status === "valid" &&
					definition.enabled &&
					definition.schedule.kind !== "manual"
				) {
					try {
						await dispatch(
							definition,
							"scheduled",
							`scheduled:${pulseKey(definition.bindingKey, definition.id)}:${pulseDueKey(definition.schedule, now)}`,
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
	return {
		extension: defineExtension({
			name: "howaboua.pulses",
			tasks: [Anchor, Run],
		}),
		catalog,
		scan,
		async run(
			request: { bindingKey: string; pulseId: string; requestId: string },
			context: Context,
		) {
			if (!request.requestId.trim())
				throw new Error("A stable requestId is required");
			return exclusive(async () => {
				const requestId = `manual:${request.requestId}`;
				const receipt = await host().commit(
					(tx) => admitted(tx, request.bindingKey, request.pulseId, requestId),
					context,
				);
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
		bind(value: Harness, context: Context) {
			if (harness && harness !== value)
				throw new Error("Create one Pulses component per Harness");
			if (timer) return;
			harness = value;
			accepting = true;
			unsubscribeClose = value.subscribeClose(() => {
				accepting = false;
				if (timer) clearInterval(timer);
				timer = undefined;
				unsubscribeClose?.();
				unsubscribeClose = undefined;
			});
			timer = setInterval(() => {
				void scan(context).catch(options.onError);
			}, 300_000);
			timer.unref?.();
			void exclusive(() => host().commit(restoreMissingReferences, context))
				.then(() => scan(context))
				.catch((error: unknown) => {
					accepting = false;
					if (timer) clearInterval(timer);
					timer = undefined;
					unsubscribeClose?.();
					unsubscribeClose = undefined;
					options.onError(error);
				});
		},
		/** Stop admission first; host must drain/close native task invocations before releasing this binding. */
		async unbind() {
			accepting = false;
			unsubscribeClose?.();
			unsubscribeClose = undefined;
			if (timer) clearInterval(timer);
			timer = undefined;
			await pending;
			harness = undefined;
		},
	};
}
