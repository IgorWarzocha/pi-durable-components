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
import { createRollover, scheduleRollover } from "./rollover.ts";
import { createToolRollover } from "./tool-rollover.ts";
import { WindowState } from "./window-state.ts";

export type { InputResult } from "./lifecycle.ts";
export { readSavedNotes, type SavedNote } from "./note-store.ts";
export type { TransitionResult, WindowIdentity } from "./window-state.ts";

/** Install the extension before opening. Bind the same Harness and storage before resuming it. */
export function createContextManagement(options: {
	models: Models;
	now?: () => number;
	automaticIdleRollover?: boolean;
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
	const input = createInput(
		host,
		rollover,
		options.automaticIdleRollover ?? false,
	);
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
	const newContext = createToolRollover(host, now);
	const extension = defineExtension({
		name: "howaboua.context",
		tools: [notes, history, policy.remainingTool, newContext.tool],
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
