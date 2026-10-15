import {
	defineDoc,
	defineTool,
	GenerationTask,
	hook,
	InboxDoc,
	LiveDoc,
	type TaskId,
	UserEntry,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { type ContextHost, conversation, foreignTasks } from "./lifecycle.ts";
import { notesAreFresh } from "./note-store.ts";
import {
	WindowEntry,
	type WindowIdentity,
	WindowState,
} from "./window-state.ts";

// The generation owns this receipt: tool documents retire before afterTools runs.
const ToolWindow = defineDoc<{
	request?: { tool: TaskId; window: WindowIdentity };
	finished?: boolean;
}>({
	kind: "howaboua.context.tool-window",
	version: 1,
	scope: "task",
	initial: () => ({}),
});

/** A tool-requested cut stays inside its native input, so every submission waiter sees the final answer. */
export function createToolRollover(host: () => ContextHost, now: () => number) {
	const tool = defineTool({
		name: "new_context",
		description:
			"Start fresh from saved notes; recover earlier conversation through history. Save notes first and call alone",
		parameters: Type.Object({}, { additionalProperties: false }),
		replay: "safe",
		callers: ["model"],
		executionMode: "sequential",
		async execute(_args, api, context) {
			const result = await api.commit(async (tx) => {
				const live = await tx.doc(LiveDoc, api.conversationId);
				if (
					!live.run ||
					live.tools?.length !== 1 ||
					live.tools[0]?.taskId !== api.taskId
				)
					throw new Error("Call new_context alone in its native tool round");
				const state = await tx.doc(WindowState, api.conversationId);
				if (!state.window || state.transition)
					throw new Error(
						"Context window is missing or a checkpoint is already in progress",
					);
				if (!(await notesAreFresh(tx, api.conversationId)))
					return {
						status: "checkpoint_required",
						message:
							"Save the current task checkpoint in notes, then call new_context alone again. The current window has not changed.",
					};
				const receipt = await tx.doc(ToolWindow, live.run.taskId);
				receipt.request ??= {
					tool: api.taskId,
					window: {
						id: crypto.randomUUID(),
						number: state.window.number + 1,
						startedAt: now(),
						previous: state.window.id,
					},
				};
				return { status: "scheduled", window_id: receipt.request.window.id };
			}, context);
			return { output: [{ type: "text", text: JSON.stringify(result) }] };
		},
	});
	const hooks = [
		hook(GenerationTask, {
			async afterTools(_assistant, _results, api, context) {
				const pending = await api.snapshot(ToolWindow, api.taskId, context);
				if (!pending?.request || pending.finished) return;
				const conv = await conversation(host(), api.conversationId, context);
				await conv.commit(async (tx) => {
					const receipt = await tx.doc(ToolWindow, api.taskId);
					if (!receipt.request || receipt.finished) return;
					const live = await tx.doc(LiveDoc, api.conversationId);
					const inbox = await tx.doc(InboxDoc, api.conversationId);
					const state = await tx.doc(WindowState, api.conversationId);
					const slot = live.tools?.[0];
					const generation = await tx.task(api.taskId);
					// Only this paused generation may be live. The completed round is cut as a whole.
					const safe =
						live.run?.taskId === api.taskId &&
						!generation?.abortRequested &&
						live.tools?.length === 1 &&
						slot?.taskId === receipt.request.tool &&
						slot.status === "done" &&
						slot.entry !== undefined &&
						inbox.items.length === 0 &&
						!state.transition &&
						state.window?.id === receipt.request.window.previous &&
						(await notesAreFresh(tx, api.conversationId)) &&
						(await foreignTasks(tx, api.conversationId)).every(
							(id) => id === api.taskId,
						);
					receipt.finished = true;
					if (safe) {
						const window = { ...receipt.request.window, startedAt: now() };
						const entry = await tx.appendEntry(
							WindowEntry,
							api.conversationId,
							{
								data: window,
								head: "self",
							},
						);
						state.window = window;
						state.entry = entry.id;
						state.reminded = 0;
						delete state.settlement;
					}
					await tx.appendEntry(UserEntry, api.conversationId, {
						model: [
							{
								role: "user",
								content: safe
									? "Read your saved notes and resume the task."
									: "Context rollover was skipped because the conversation changed or foreground work is still running. The window is unchanged. Save fresh notes and retry new_context after that work settles.",
								timestamp: now(),
							},
						],
					});
				}, context);
			},
		}),
	];
	return {
		tool: { ...tool, executionHints: { nativeOnly: true as const } },
		hooks,
	};
}
