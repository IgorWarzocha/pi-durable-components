import type { Tx } from "@earendil-works/pi-durable";
import type { PulseCatalogItem } from "./definitions.ts";
import {
	isPulseQuietAt,
	nextPulseDue,
	pulseDueKey,
	pulseOccurrences,
} from "./schedule.ts";
import { Checkpoints, type PulseCheckpoint, pulseKey } from "./state.ts";

function discardPending(
	checkpoint: PulseCheckpoint,
	status: "obsolete" | "superseded",
	reason: string,
	now: number,
) {
	if (checkpoint.pending) {
		checkpoint.disposition = {
			status,
			reason,
			at: now,
			occurrence: { ...checkpoint.pending },
		};
		delete checkpoint.pending;
	}
	delete checkpoint.blocked;
}

function collectDue(checkpoint: PulseCheckpoint, now: number) {
	if (
		!checkpoint.scheduledEligible ||
		!checkpoint.trackedSchedule ||
		checkpoint.nextDueAt === undefined
	)
		return;
	const due = pulseOccurrences(
		checkpoint.trackedSchedule,
		checkpoint.nextDueAt,
		Math.min(now, checkpoint.expiresAt ?? now),
	);
	if (!due) return;
	checkpoint.pending = checkpoint.pending
		? {
				count: checkpoint.pending.count + due.count,
				startAt: checkpoint.pending.startAt,
				endAt: due.endAt,
			}
		: due;
	const next = nextPulseDue(checkpoint.trackedSchedule, due.endAt);
	if (next === undefined) delete checkpoint.nextDueAt;
	else checkpoint.nextDueAt = next;
}

/** Reconcile source state before policy: a pause retains every tracked due slot. */
export async function reconcileSchedules(
	tx: Tx,
	definitions: readonly PulseCatalogItem[],
	now: number,
) {
	const state = await tx.doc(Checkpoints);
	// Source edits/removal cannot erase tracked slots that elapsed during downtime.
	for (const checkpoint of Object.values(state.pulses))
		collectDue(checkpoint, now);
	const eligible = new Set<string>();
	for (const definition of definitions) {
		const key = pulseKey(definition.bindingKey, definition.id);
		if (
			definition.status !== "valid" ||
			!definition.enabled ||
			definition.schedule.kind === "manual" ||
			(definition.expiresAt !== undefined && definition.expiresAt <= now)
		)
			continue;
		eligible.add(key);
		state.pulses[key] ??= { firstSeenAt: now, history: [] };
		const checkpoint = state.pulses[key];
		if (!checkpoint) throw new Error("Missing initialized pulse checkpoint");
		// Target changes supersede unaccepted work; body/cosmetic edits preserve recurrence.
		const scheduleKey = JSON.stringify({
			schedule: definition.schedule,
			target: definition.target ?? "child",
		});
		if (
			!checkpoint.scheduledEligible ||
			checkpoint.scheduleKey !== scheduleKey ||
			checkpoint.trackedAt === undefined
		) {
			discardPending(
				checkpoint,
				"superseded",
				"Schedule or execution target changed",
				now,
			);
			checkpoint.firstSeenAt = now;
			checkpoint.trackedAt = now;
			checkpoint.trackedSchedule = definition.schedule;
			delete checkpoint.lastRunAt;
			delete checkpoint.lastDueKey;
			delete checkpoint.nextDueAt;
			const seed = pulseDueKey(definition.schedule, now);
			if (seed !== null) checkpoint.lastDueKey = seed;
			const next = nextPulseDue(definition.schedule, now);
			if (next !== undefined) checkpoint.nextDueAt = next;
			checkpoint.scheduledEligible = true;
			checkpoint.scheduleKey = scheduleKey;
		}
		if (definition.expiresAt === undefined) delete checkpoint.expiresAt;
		else checkpoint.expiresAt = definition.expiresAt;
		if (definition.quietHours === undefined) delete checkpoint.quietHours;
		else checkpoint.quietHours = definition.quietHours;
	}
	for (const [key, checkpoint] of Object.entries(state.pulses)) {
		if (eligible.has(key)) continue;
		const definition = definitions.find(
			(value) => pulseKey(value.bindingKey, value.id) === key,
		);
		const reason = !definition
			? "Definition removed"
			: definition.status === "invalid"
				? `Invalid definition: ${definition.error}`
				: !definition.enabled
					? "Definition disabled"
					: definition.expiresAt !== undefined && definition.expiresAt <= now
						? "Definition expired"
						: "Schedule made manual";
		discardPending(checkpoint, "obsolete", reason, now);
		checkpoint.scheduledEligible = false;
		delete checkpoint.nextDueAt;
		delete checkpoint.lastRunAt;
		delete checkpoint.lastDueKey;
	}
}

/** Transaction-only readiness for cross-source priority. No files or host reads. */
export async function explicitReady(
	tx: Tx,
	bindingKey: string,
	now: number,
): Promise<boolean> {
	const state = await tx.doc(Checkpoints);
	if ((state.backoffUntil ?? 0) > now) return false;
	return Object.entries(state.pulses).some(([key, checkpoint]) => {
		const identity: unknown = JSON.parse(key);
		return (
			Array.isArray(identity) &&
			identity[0] === bindingKey &&
			checkpoint.scheduledEligible &&
			(checkpoint.expiresAt === undefined || checkpoint.expiresAt > now) &&
			(checkpoint.quietHours === undefined ||
				!isPulseQuietAt(checkpoint.quietHours, now)) &&
			(checkpoint.pending !== undefined ||
				(checkpoint.nextDueAt !== undefined && checkpoint.nextDueAt <= now))
		);
	});
}
