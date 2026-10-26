import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";
import type {
	ConversationId,
	Harness,
	InputSubmissionDraft,
	Storage,
	TaskId,
} from "@earendil-works/pi-durable";
import { defineExtension } from "@earendil-works/pi-durable";
import { createInput } from "./admission.ts";
import { createHistoryTool } from "./history.ts";
import type { RankedHistory } from "./history-ranker.ts";
import {
	Admission,
	type ContextHost,
	conversation,
	InputReceipt,
	type InputResult,
	initializeWindow,
} from "./lifecycle.ts";
import { createNotesTool } from "./notes.ts";
import { createContextPolicy } from "./policy.ts";
import type { ContextRemoteCatalog } from "./remote.ts";
import { createRollover, scheduleRollover } from "./rollover.ts";
import type { BeforeRollover } from "./rollover-preparation.ts";
import { createToolRollover } from "./tool-rollover.ts";
import { WindowState } from "./window-state.ts";

export type { HistoryRanker, RankedHistory } from "./history-ranker.ts";
export type { InputResult } from "./lifecycle.ts";
export { readSavedNotes, type SavedNote } from "./note-store.ts";
export type { ContextRemoteCatalog } from "./remote.ts";
export type { BeforeRollover } from "./rollover-preparation.ts";
export type { TransitionResult, WindowIdentity } from "./window-state.ts";

/** Policy for model-requested context windows. */
export type NewContextRequests = "off" | "pi-limits" | "unrestricted";

/** Install the extension before opening. Bind the same Harness and storage before resuming it. */
export function createContextManagement(options: {
	models: Models;
	/** Include retained fork branches and prioritise native summary search matches. Off by default. */
	archiveHistory?: boolean;
	/** Opt in to retired visible-text ranking with an explicit host-granted index. */
	rankedHistory?: RankedHistory;
	/** Await connected-service refresh before a window cut. Interrupted effects are not replayed. */
	beforeRollover?: BeforeRollover;
	/** Opt in to a host-owned stable family and agent namespace. No local fallback. */
	remote?: ContextRemoteCatalog;
	now?: () => number;
	/** Agent-requested rollover policy. `pi-limits` requires the host's history-eligibility signal below. */
	newContextRequests?: NewContextRequests;
	/** Read-only host signal for history eligible for a new window; errors fail closed. */
	hasEligibleContextHistory?: (
		conversationId: ConversationId,
		context: Context,
	) => boolean | Promise<boolean>;
	automaticIdleRollover?: boolean;
	/** Minutes of observed idle time. Explicit policy overrides the legacy boolean. */
	idleRolloverMinutes?: 0 | 5 | 15 | 25 | 55 | 115 | 355 | 715;
	/** Once-per-window suggestion for contexts larger than 272k. Zero disables it. */
	taskBoundaryReminderTokens?: number;
}) {
	let binding: ContextHost | undefined;
	if (
		options.remote !== undefined &&
		typeof options.remote?.catalog !== "function"
	)
		throw new Error("Remote Context requires a host-configured catalogue");
	if (
		options.archiveHistory !== undefined &&
		typeof options.archiveHistory !== "boolean"
	)
		throw new Error("archiveHistory must be a boolean");
	const host = () => {
		if (!binding)
			throw new Error(
				"Call context.bind(harness, storage) before using context management",
			);
		return binding;
	};
	if (
		options.automaticIdleRollover !== undefined &&
		typeof options.automaticIdleRollover !== "boolean"
	)
		throw new Error("automaticIdleRollover must be a boolean");
	const idleMinutes =
		options.idleRolloverMinutes !== undefined
			? options.idleRolloverMinutes
			: options.automaticIdleRollover
				? 25
				: 0;
	if (![0, 5, 15, 25, 55, 115, 355, 715].includes(idleMinutes))
		throw new Error(
			"idleRolloverMinutes must be 0, 5, 15, 25, 55, 115, 355 or 715",
		);
	const taskBoundaryReminderTokens =
		options.taskBoundaryReminderTokens === undefined
			? 0
			: options.taskBoundaryReminderTokens;
	if (
		!Number.isSafeInteger(taskBoundaryReminderTokens) ||
		taskBoundaryReminderTokens < 0
	)
		throw new Error(
			"taskBoundaryReminderTokens must be a non-negative safe integer",
		);
	const now = options.now ?? Date.now;
	const newContextRequests = options.newContextRequests ?? "unrestricted";
	if (
		newContextRequests !== "off" &&
		newContextRequests !== "pi-limits" &&
		newContextRequests !== "unrestricted"
	)
		throw new Error(
			"newContextRequests must be off, pi-limits or unrestricted",
		);
	if (
		newContextRequests === "pi-limits" &&
		options.hasEligibleContextHistory === undefined
	)
		throw new Error(
			"pi-limits requires hasEligibleContextHistory from the host",
		);
	const ensureWindow = async (id: ConversationId, context: Context) => {
		const conv = await conversation(host(), id, context);
		await conv.commit((tx) => initializeWindow(tx, id, now()), context);
	};
	const rollover = createRollover(host, options.beforeRollover);
	const input = createInput(host, rollover, idleMinutes * 60 * 1000);
	const policy = createContextPolicy({
		models: options.models,
		host,
		now,
		ensureWindow,
		taskBoundaryReminderTokens,
		newContextRequests,
		archiveHistory: options.archiveHistory === true,
		rankedHistory: options.rankedHistory,
	});
	const notes = createNotesTool({
		now,
		storage: () => host().storage,
		remote: options.remote,
	});
	const history = createHistoryTool({
		conversation: (id, context) => conversation(host(), id, context),
		storage: () => host().storage,
		remote: options.remote,
		archiveHistory: options.archiveHistory === true,
		rankedHistory: options.rankedHistory,
	});
	const newContext = createToolRollover(host, now, {
		newContextRequests,
		beforeRollover: options.beforeRollover,
		...(options.hasEligibleContextHistory === undefined
			? {}
			: { hasEligibleContextHistory: options.hasEligibleContextHistory }),
	});
	const extension = defineExtension({
		name: "howaboua.context",
		tools: [
			notes,
			history,
			policy.remainingTool,
			...(newContextRequests === "off" ? [] : [newContext.tool]),
		],
		tasks: [input, rollover],
		sections: policy.sections,
		hooks: [...newContext.hooks, ...policy.hooks],
	});
	return {
		extension,
		bind(harness: Harness, storage: Storage) {
			if (
				binding &&
				(binding.harness !== harness || binding.storage !== storage)
			)
				throw new Error("Create a separate context component for each Harness");
			binding = { harness, storage };
		},
		/** Release only after draining host calls and closing this Harness and its task invocations. */
		unbind(harness: Harness): void {
			if (binding?.harness === harness) binding = undefined;
		},
		async submit(
			id: ConversationId,
			draft: InputSubmissionDraft,
			context: Context,
		): Promise<TaskId<InputResult>> {
			await ensureWindow(id, context);
			const conv = await conversation(host(), id, context);
			const task = await conv.commit(async (tx) => {
				const receipt =
					draft.requestId === undefined
						? undefined
						: await tx.doc(InputReceipt, id, draft.requestId, null);
				if (receipt?.task) return receipt.task;
				const gate = await tx.doc(Admission, id);
				const created = await tx.createTask(input, draft, {
					ownership: { kind: "conversation" },
				});
				gate.queue.push(created);
				gate.retry++;
				if (receipt) receipt.task = created;
				return created;
			}, context);
			host().harness.resume();
			return task;
		},
		async newContext(id: ConversationId, context: Context) {
			await ensureWindow(id, context);
			const conv = await conversation(host(), id, context);
			const task = await conv.commit(
				(tx) => scheduleRollover(tx, id, rollover, "manual"),
				context,
			);
			host().harness.resume();
			return task;
		},
		async retry(id: ConversationId, context: Context): Promise<void> {
			const conv = await conversation(host(), id, context);
			await conv.commit(async (tx) => {
				(await tx.doc(Admission, id)).retry++;
			}, context);
			host().harness.resume();
		},
		async status(id: ConversationId, context: Context) {
			return {
				window: await host().harness.snapshot(WindowState, id, context),
				admission: await host().harness.snapshot(Admission, id, context),
			};
		},
	};
}
