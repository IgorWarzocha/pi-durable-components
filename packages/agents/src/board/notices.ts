import type {
	ConversationId,
	HookApi,
	JsonObject,
	SubmissionId,
	Tx,
} from "@earendil-works/pi-durable";
import { defineDoc, LiveDoc, UserEntry } from "@earendil-works/pi-durable";

export const BoardNotices = defineDoc<{
	pending: Record<string, { input: SubmissionId; content: string }>;
}>({
	kind: "howaboua.agents.board.notices",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ pending: {} }),
});

type Delivery = { input: SubmissionId; content: string; timestamp: number };
export const BoardNoticeReceipt = defineDoc<{
	beforeRequest: Delivery | null;
	onYield: Delivery | null;
}>({
	kind: "howaboua.agents.board.notice-receipt",
	version: 1,
	scope: "task",
	initial: () => ({ beforeRequest: null, onYield: null }),
});

async function activeRun(tx: Tx, conversationId: ConversationId) {
	const live = await tx.doc(LiveDoc, conversationId);
	const input = live.run?.inputs[0];
	if (live.run === undefined || input === undefined) return undefined;
	const task = await tx.task(live.run.taskId);
	if (
		task === undefined ||
		task.abortRequested ||
		task.state.status === "terminal" ||
		task.state.status === "completing"
	)
		return undefined;
	// Generation tasks hand run control over. The first input stays with the run.
	return { taskId: live.run.taskId, input };
}

function discardStale(
	pending: Record<string, { input: SubmissionId; content: string }>,
	input: SubmissionId | undefined,
) {
	for (const [key, notice] of Object.entries(pending)) {
		if (notice.input !== input) delete pending[key];
	}
}

/** Queue only new notices for current runs. The caller owns the post and its retry receipt. */
export async function queueBoardNotices(
	tx: Tx,
	targets: readonly { conversationId: ConversationId; agentName: string }[],
	notice: JsonObject,
	requestId: string,
): Promise<number> {
	const recipients = [
		...new Set(targets.map((target) => target.conversationId)),
	];
	// Keep all recipient reads together, even though admission writes only documents.
	const prepared = [];
	for (const conversationId of recipients) {
		const run = await activeRun(tx, conversationId);
		const notices = await tx.doc(BoardNotices, conversationId);
		prepared.push({ run, notices });
	}

	const content = `Board post ${JSON.stringify(notice)}`;
	let queued = 0;
	for (const { run, notices } of prepared) {
		discardStale(notices.pending, run?.input);
		if (run === undefined || Object.hasOwn(notices.pending, requestId))
			continue;
		notices.pending[requestId] = { input: run.input, content };
		queued++;
	}
	return queued;
}

/** A receipt covers a hook's separate commit, including a crash before native continuation. */
export async function receiveBoardNotices(
	tx: Tx,
	api: Pick<HookApi, "conversationId" | "taskId">,
	at: "beforeRequest" | "onYield",
): Promise<{ content: string; timestamp: number } | undefined> {
	const run = await activeRun(tx, api.conversationId);
	const notices = await tx.doc(BoardNotices, api.conversationId);
	const receipt = await tx.doc(BoardNoticeReceipt, api.taskId);
	discardStale(notices.pending, run?.input);
	if (run === undefined || run.taskId !== api.taskId) return undefined;
	const saved = receipt[at];
	if (saved !== null && saved.input === run.input)
		return { content: saved.content, timestamp: saved.timestamp };
	const pending = Object.entries(notices.pending);
	if (pending.length === 0) return undefined;
	const delivery = {
		input: run.input,
		content: pending.map(([, notice]) => notice.content).join("\n"),
		timestamp: Date.now(),
	};
	for (const [key] of pending) delete notices.pending[key];
	receipt[at] = delivery;
	if (at === "beforeRequest") {
		await tx.appendEntry(UserEntry, api.conversationId, {
			model: [
				{
					role: "user",
					content: delivery.content,
					timestamp: delivery.timestamp,
				},
			],
		});
	}
	return { content: delivery.content, timestamp: delivery.timestamp };
}
