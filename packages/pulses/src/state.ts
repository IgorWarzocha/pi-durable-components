import {
	type ConversationId,
	type Cursor,
	defineDoc,
	type TaskId,
	type Tx,
} from "@earendil-works/pi-durable";
import type { PulseOccurrence } from "./contract.ts";
import type { PulseQuietHours, PulseSchedule } from "./schedule.ts";

export type PulseReference = {
	conversationId: ConversationId;
	root: string;
	pulseHome: string;
	parentConversationId?: ConversationId;
	target?: "child" | "resident";
};
export type PulseDisposition = {
	status: "obsolete" | "superseded";
	reason: string;
	at: number;
	occurrence: PulseOccurrence;
};
export type PulseCheckpoint = {
	firstSeenAt: number;
	scheduledEligible?: boolean;
	/** Parsed schedule identity. Missing legacy values seed the current slot on discovery. */
	scheduleKey?: string;
	/** Exact accounting starts here, never inferred from legacy lastRunAt. */
	trackedAt?: number;
	trackedSchedule?: PulseSchedule;
	quietHours?: PulseQuietHours;
	expiresAt?: number;
	nextDueAt?: number;
	pending?: PulseOccurrence;
	blocked?: { reason: string; retryAt?: number };
	disposition?: PulseDisposition;
	lastRunAt?: number;
	lastDueKey?: string;
	current?: PulseReference;
	history: PulseReference[];
	activeTask?: TaskId;
};
export const Checkpoints = defineDoc<{
	pulses: Record<string, PulseCheckpoint>;
	concurrency?: number;
	backoffUntil?: number;
}>({
	kind: "howaboua.pulses.checkpoints",
	version: 1,
	scope: "session",
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
	initial: () => ({ pulses: {} }),
});
export const pulseKey = (bindingKey: string, id: string) =>
	JSON.stringify([bindingKey, id]);

/** Repair only missing conversation references from already admitted native task inputs, never rerun work. */
export async function restoreMissingReferences(tx: Tx) {
	const state = await tx.doc(Checkpoints);
	const missing = new Set(
		Object.entries(state.pulses)
			.filter(
				([, checkpoint]) =>
					!checkpoint.current &&
					checkpoint.activeTask === undefined &&
					checkpoint.history.length === 0,
			)
			.map(([key]) => key),
	);
	if (missing.size === 0) return;
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
				throw new Error("Invalid admitted pulse input");
			const binding = input["binding"];
			const definition = input["definition"];
			if (
				typeof binding !== "object" ||
				binding === null ||
				Array.isArray(binding) ||
				typeof binding["key"] !== "string" ||
				typeof definition !== "object" ||
				definition === null ||
				Array.isArray(definition) ||
				typeof definition["id"] !== "string"
			)
				throw new Error("Invalid admitted pulse identity");
			const key = pulseKey(binding["key"], definition["id"]);
			if (!missing.has(key)) continue;
			const reference = input["reference"];
			if (
				typeof reference !== "object" ||
				reference === null ||
				Array.isArray(reference) ||
				reference["conversationId"] !== task.conversationId ||
				typeof reference["root"] !== "string" ||
				typeof reference["pulseHome"] !== "string"
			)
				throw new Error("Invalid admitted pulse conversation reference");
			const conversation = await tx.conversation(task.conversationId);
			const resident = definition["target"] === "resident";
			if (
				!conversation ||
				(resident
					? conversation.id !== binding["parentConversationId"]
					: reference["parentConversationId"] !==
						conversation.owner?.conversationId)
			)
				throw new Error("Admitted pulse conversation ownership is unavailable");
			const checkpoint = state.pulses[key];
			if (!checkpoint) throw new Error("Missing pulse reference checkpoint");
			const restored: PulseReference = {
				conversationId: conversation.id,
				root: reference["root"],
				pulseHome: reference["pulseHome"],
				...(resident ? { target: "resident" as const } : {}),
				...(!resident && conversation.owner
					? { parentConversationId: conversation.owner.conversationId }
					: {}),
			};
			checkpoint.current = restored;
			checkpoint.history.push(restored);
			checkpoint.activeTask = task.id;
			missing.delete(key);
			if (missing.size === 0) return;
		}
		cursor = page.next;
	} while (cursor !== undefined);
}
