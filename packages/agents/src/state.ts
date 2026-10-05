import type { Message } from "@earendil-works/pi-ai";
import type {
	ConversationId,
	EntryId,
	SettledSubmissionRecord,
	SubmissionId,
	TaskId,
	Tx,
} from "@earendil-works/pi-durable";
import { defineDoc } from "@earendil-works/pi-durable";

export type AgentRecord = {
	target: ConversationId;
	name: string;
	label: string;
	profile: string;
	controller: ConversationId;
};
export type WorkResult = {
	target: ConversationId;
	status: "done" | "failed";
	reply: string;
	answer?: EntryId;
	reason?: string;
	submission?: SubmissionId;
};
export type Delegation = {
	target: ConversationId;
	name: string;
	boardAgent?: string;
	blocking: boolean;
	dispatch: TaskId<WorkResult>;
	reporter: TaskId<null>;
};

export const Fleet = defineDoc<{
	agents: Record<string, AgentRecord>;
	delegations: Record<string, Delegation>;
	watches: Record<string, TaskId<null>>;
	changes: Record<string, { target: ConversationId; watched: boolean }>;
}>({
	kind: "howaboua.agents.fleet",
	version: 1,
	scope: "session",
	initial: () => ({ agents: {}, delegations: {}, watches: {}, changes: {} }),
});

/** Names resolve through our metadata. Numeric IDs also admit host-created peers. */
export async function resolveTarget(
	tx: Tx,
	target: string,
): Promise<ConversationId> {
	const fleet = await tx.doc(Fleet);
	const named = Object.values(fleet.agents).find(
		(agent) => agent.name === target,
	);
	if (named !== undefined) return named.target;
	const numeric = Number(target);
	if (!/^\d+$/.test(target) || !Number.isSafeInteger(numeric) || numeric < 0) {
		throw new Error(
			`Unknown agent ${JSON.stringify(target)}; use list or find`,
		);
	}
	// Durable brands numeric IDs. Existence is checked before the ID leaves this boundary.
	const id = numeric as ConversationId;
	if ((await tx.conversation(id)) === undefined)
		throw new Error(`No conversation ${target}`);
	return id;
}

export function textOf(messages: readonly Message[] | undefined): string {
	return (messages ?? [])
		.flatMap((message) => {
			if (typeof message.content === "string") return [message.content];
			return message.content.flatMap((part) =>
				part.type === "text" ? [part.text] : [],
			);
		})
		.join("\n");
}

async function resultOf(
	tx: Tx,
	target: ConversationId,
	answer: EntryId,
): Promise<WorkResult> {
	const entry = await tx.entry(answer);
	const message = entry?.model?.find((item) => item.role === "assistant");
	if (message === undefined)
		throw new Error(`Answer entry ${answer} has no assistant message`);
	const failed =
		message.stopReason === "error" || message.stopReason === "aborted";
	return {
		target,
		answer,
		status: failed ? "failed" : "done",
		reply: textOf([message]),
		...(failed ? { reason: message.errorMessage ?? message.stopReason } : {}),
	};
}

export function reportKey(
	controller: ConversationId,
	result: WorkResult,
	fallback: TaskId,
): string {
	const outcome =
		result.answer ??
		(result.submission === undefined
			? `task-${fallback}`
			: `input-${result.submission}`);
	return `agents:report:${controller}:${result.target}:${outcome}`;
}

export async function submissionResult(
	tx: Tx,
	target: ConversationId,
	settled: SettledSubmissionRecord,
): Promise<WorkResult> {
	const result: WorkResult =
		settled.status === "done" && settled.type === "input"
			? await resultOf(tx, target, settled.answer)
			: {
					target,
					status: "failed",
					reply: typeof settled.detail === "string" ? settled.detail : "",
					reason: settled.reason ?? "No answer",
				};
	return { ...result, submission: settled.id };
}
