import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";
import type {
	ConversationId,
	Harness,
	InputSubmissionDraft,
	Storage,
	TaskId,
} from "@earendil-works/pi-durable";
import {
	defineDoc,
	defineExtension,
	defineTool,
	LiveDoc,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { createInput } from "./admission.ts";
import { createHistoryTool } from "./history.ts";
import {
	Admission,
	type ContextHost,
	Continuation,
	conversation,
	InputReceipt,
	type InputResult,
	initializeWindow,
} from "./lifecycle.ts";
import { createNotesTool } from "./notes.ts";
import { createContextPolicy } from "./policy.ts";
import { createRollover, scheduleRollover } from "./rollover.ts";
import { WindowState } from "./window-state.ts";

export type { InputResult } from "./lifecycle.ts";
export { readSavedNotes, type SavedNote } from "./note-store.ts";
export type { TransitionResult, WindowIdentity } from "./window-state.ts";

const ToolReceipt = defineDoc<{ transition?: TaskId }>({
	kind: "howaboua.context.rollover-receipt",
	version: 1,
	scope: "task",
	initial: () => ({}),
});

/** Install the extension before opening. Bind the same Harness and storage before resuming it. */
export function createContextManagement(options: {
	models: Models;
	now?: () => number;
}) {
	let binding: ContextHost | undefined;
	const host = () => {
		if (!binding)
			throw new Error(
				"Call context.bind(harness, storage) before using context management",
			);
		return binding;
	};
	const now = options.now ?? Date.now;
	const ensureWindow = async (id: ConversationId, context: Context) => {
		const conv = await conversation(host(), id, context);
		await conv.commit((tx) => initializeWindow(tx, id, now()), context);
	};
	const rollover = createRollover(host);
	const input = createInput(host, rollover);
	const policy = createContextPolicy({
		models: options.models,
		host,
		now,
		ensureWindow,
	});
	const notes = createNotesTool({ now });
	const history = createHistoryTool({
		conversation: (id, context) => conversation(host(), id, context),
	});
	const newContext = defineTool({
		name: "new_context",
		description:
			"Checkpoint and continue in a clean context window. Call alone",
		parameters: Type.Object({}, { additionalProperties: false }),
		replay: "safe",
		executionMode: "sequential",
		async execute(_args, api, context) {
			const transition = await api.commit(async (tx) => {
				const receipt = await tx.doc(ToolReceipt, api.taskId);
				if (receipt.transition) return receipt.transition;
				const live = await tx.doc(LiveDoc, api.conversationId);
				if (live.tools?.length !== 1)
					throw new Error(
						"Call new_context alone in its tool round, after saving notes",
					);
				const window = await tx.doc(WindowState, api.conversationId);
				if (window.transition)
					throw new Error(
						"A context checkpoint is already in progress. Save notes and finish this turn",
					);
				const pending = await scheduleRollover(
					tx,
					api.conversationId,
					rollover,
					"tool",
				);
				for (const submission of live.run?.inputs ?? [])
					(
						await tx.doc(
							Continuation,
							api.conversationId,
							String(submission),
							null,
						)
					).task = pending;
				receipt.transition = pending;
				return pending;
			}, context);
			// The current generation must end before its rollover can wait for idle.
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							status: "scheduled",
							task_id: String(transition),
						}),
					},
				],
				control: { terminate: true },
			};
		},
	});
	const nativeNewContext = {
		...newContext,
		executionHints: { nativeOnly: true as const },
	};
	const extension = defineExtension({
		name: "howaboua.context",
		tools: [notes, history, policy.remainingTool, nativeNewContext],
		tasks: [input, rollover],
		sections: policy.sections,
		hooks: policy.hooks,
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
