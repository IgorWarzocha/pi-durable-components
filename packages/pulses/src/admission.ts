import type { Context } from "@earendil-works/chord";
import {
	type Cursor,
	type Harness,
	InboxDoc,
	LiveDoc,
	type TaskId,
	type Tx,
} from "@earendil-works/pi-durable";
import type {
	PulseAdmissionDecision,
	PulsesOptions,
	PulseTrigger,
} from "./contract.ts";
import type { PulseDefinition } from "./definitions.ts";
import { isPulseQuietAt, pulseDueKey } from "./schedule.ts";
import { Checkpoints, type PulseReference, pulseKey } from "./state.ts";
import { Anchor, type createRunTask } from "./tasks.ts";

/** Native task inputs are the request authority, not a second receipt ledger. */
export async function admitted(
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

/** Count live coordinators, including those restored after restart and awaiting reporting. */
async function capacity(tx: Tx) {
	let cursor: Cursor | undefined;
	let active = 0;
	let backoffUntil = 0;
	do {
		const page = await tx.scanTasks(
			{ kind: "howaboua.pulses.run" },
			100,
			cursor,
		);
		for (const task of page.items) {
			if (task.state.status === "terminal") continue;
			active++;
			const live = await tx.doc(LiveDoc, task.conversationId);
			// Only the native structured generation deadline is evidence of provider backoff.
			backoffUntil = Math.max(backoffUntil, live.generation?.retry?.at ?? 0);
		}
		cursor = page.next;
	} while (cursor !== undefined);
	return { active, backoffUntil };
}

class AdmissionBlocked extends Error {
	readonly decision: Extract<PulseAdmissionDecision, { status: "blocked" }>;
	constructor(
		decision: Extract<PulseAdmissionDecision, { status: "blocked" }>,
	) {
		super(decision.reason);
		this.decision = decision;
	}
}

export function validateConcurrency(limit: number) {
	if (!Number.isSafeInteger(limit) || limit < 1)
		throw new Error("Pulse concurrency must be a positive safe integer");
	return limit;
}

export function createAdmission(
	host: () => Harness,
	options: PulsesOptions,
	Run: ReturnType<typeof createRunTask>,
	accepting: () => boolean,
) {
	return async function dispatch(
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
		if (!accepting()) throw new Error("Pulses admission has stopped");
		const now = Date.now();
		try {
			const id = await host().commit(async (tx) => {
				const existing = await admitted(
					tx,
					binding.key,
					definition.id,
					requestId,
				);
				if (existing !== undefined) return existing;
				const state = await tx.doc(Checkpoints);
				const key = pulseKey(binding.key, definition.id);
				state.pulses[key] ??= { firstSeenAt: now, history: [] };
				const checkpoint = state.pulses[key];
				if (!checkpoint)
					throw new Error("Missing initialized pulse checkpoint");
				if (checkpoint.activeTask !== undefined) {
					const active = await tx.task(checkpoint.activeTask);
					if (!active) throw new Error("Missing pulse task");
					if (active.state.status !== "terminal") return undefined;
				}
				if (definition.expiresAt !== undefined && definition.expiresAt <= now)
					throw new Error("Pulse definition expired");
				if (
					trigger === "scheduled" &&
					(!definition.enabled || !checkpoint.pending)
				)
					return undefined;
				if (
					trigger === "scheduled" &&
					definition.quietHours &&
					isPulseQuietAt(definition.quietHours, now)
				) {
					checkpoint.blocked = { reason: "Pulse quiet hours" };
					return undefined;
				}
				const slots = await capacity(tx);
				state.backoffUntil = Math.max(
					state.backoffUntil ?? 0,
					slots.backoffUntil,
				);
				if ((state.backoffUntil ?? 0) > now) {
					checkpoint.blocked = {
						reason: "Native provider generation backoff",
						retryAt: state.backoffUntil,
					};
					return undefined;
				}
				if (slots.active >= (state.concurrency ?? options.concurrency ?? 2)) {
					checkpoint.blocked = { reason: "Pulse execution concurrency limit" };
					return undefined;
				}
				const resident = definition.target === "resident";
				const current = checkpoint.current;
				const reusable =
					current &&
					(resident
						? current.target === "resident" &&
							current.conversationId === binding.parentConversationId
						: current.target !== "resident" &&
							current.parentConversationId === binding.parentConversationId);
				const conversationId = resident
					? binding.parentConversationId
					: reusable
						? current.conversationId
						: undefined;
				if (resident && conversationId === undefined)
					throw new Error(
						"Resident pulse requires an explicit resident binding",
					);
				// All committed table reads precede createTask/createConversation (Durable ReadAfterWrite).
				if (conversationId !== undefined) {
					if (!(await tx.conversation(conversationId)))
						throw new Error("Missing pulse target conversation");
					const live = await tx.doc(LiveDoc, conversationId);
					const inbox = await tx.doc(InboxDoc, conversationId);
					if (live.run !== undefined || inbox.items.length > 0) {
						checkpoint.blocked = {
							reason: "Pulse target conversation is busy",
						};
						return undefined;
					}
				}
				let reference: PulseReference;
				let created = false;
				if (resident) {
					if (conversationId === undefined)
						throw new Error("Missing resident pulse target");
					reference = {
						conversationId,
						target: "resident",
						root: binding.root,
						pulseHome: definition.pulseHome,
					};
				} else if (reusable) {
					reference = {
						...current,
						root: binding.root,
						pulseHome: definition.pulseHome,
					};
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
				}
				checkpoint.current = reference;
				const historical = checkpoint.history.findIndex(
					(item) => item.conversationId === reference.conversationId,
				);
				if (historical < 0) checkpoint.history.push(reference);
				else checkpoint.history[historical] = reference;
				// A continuing resident keeps its own native configuration and instructions.
				if (!resident)
					await options.configure(
						tx,
						reference.conversationId,
						binding,
						definition,
						{ created },
					);
				const occurrence =
					trigger === "scheduled" && checkpoint.pending
						? { ...checkpoint.pending }
						: undefined;
				const taskId = await tx.createTask(
					Run,
					{
						binding: { ...binding },
						definition: { ...definition },
						reference,
						trigger,
						requestId,
						...(occurrence ? { occurrence } : {}),
					},
					{
						ownership: { kind: "conversation" },
						conversationId: reference.conversationId,
						background: true,
					},
				);
				const decision = await options.admitTransaction?.(
					tx,
					{
						binding,
						definition,
						trigger,
						requestId,
						taskId,
						conversationId: reference.conversationId,
						...(occurrence ? { occurrence } : {}),
					},
					context,
				);
				// Never catch this inside the transaction: native changes AND host credit must roll back.
				if (decision?.status === "blocked")
					throw new AdmissionBlocked(decision);
				checkpoint.activeTask = taskId;
				delete checkpoint.blocked;
				if (trigger === "scheduled") {
					checkpoint.lastRunAt = now;
					const dueKey = pulseDueKey(definition.schedule, now);
					if (dueKey !== null) checkpoint.lastDueKey = dueKey;
					delete checkpoint.pending;
				}
				return taskId;
			}, context);
			return id;
		} catch (error) {
			if (!(error instanceof AdmissionBlocked)) throw error;
			await host().commit(async (tx) => {
				const checkpoint = (await tx.doc(Checkpoints)).pulses[
					pulseKey(binding.key, definition.id)
				];
				if (checkpoint)
					checkpoint.blocked = {
						reason: error.decision.reason,
						...(error.decision.retryAt === undefined
							? {}
							: { retryAt: error.decision.retryAt }),
					};
			}, context);
			return undefined;
		}
	};
}
