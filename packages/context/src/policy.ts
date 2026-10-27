import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";
import type {
	ConversationId,
	Harness,
	HookApi,
	Storage,
} from "@earendil-works/pi-durable";
import {
	CompactionTask,
	defineDoc,
	defineTool,
	GenerationTask,
	hook,
	section,
	ToolTask,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { refreshRankedHistory } from "./history.ts";
import { renderArchiveHistoryHint } from "./history-archive.ts";
import type { RankedHistory } from "./history-ranker.ts";
import {
	beginNoteWrite,
	notesAreFresh,
	renderNotesThreadHint,
} from "./note-store.ts";
import { contextUsage } from "./usage.ts";
import { WindowState } from "./window-state.ts";

function checkpointGuidance(
	newContextRequests: "off" | "pi-limits" | "unrestricted",
) {
	const rollover =
		newContextRequests === "off"
			? "Agent-requested context windows are disabled."
			: newContextRequests === "pi-limits"
				? "Request a new context window only when the host reports eligible history."
				: "Before requesting a new context window, save current state and wait for the write to succeed.";
	return [
		"Notes are recovery state, not a diary. Write checkpoints and reports to relative paths in your own notes. Delegates do likewise and return their note paths. Keep one concise, authoritative note per task or topic at a stable path. Task checkpoints cover request, constraints, decisions, status, next steps and history IDs. Use write_file to replace stale state and mark completion. Link to existing notes instead of copying or summarising their contents. Recording isn't permission to implement.",
		`Batch saves at meaningful milestones, not every reply or intermediate step. ${rollover} For handoffs, save current state and wait for success; include the checkpoint path. After rollover, read the checkpoint, then only needed links. Don't reread notes still in context unless they may have changed. Use history for missing details. If no checkpoint is available, use history to recover missing context.`,
		"Previous skill reads don't carry into this window. Read the skills needed for the current task.",
	].join("\n\n");
}

// Durable's onYield continuation creates a successor GenerationTask. A task receipt
// repeats the same answer's decision on recovery, not subsequent answers' decisions.
const YieldAdvisory = defineDoc<{ text?: string }>({
	kind: "howaboua.context.yield-advisory",
	version: 1,
	scope: "task",
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
	initial: () => ({}),
});

export function createContextPolicy(options: {
	models: Models;
	taskBoundaryReminderTokens: number;
	newContextRequests: "off" | "pi-limits" | "unrestricted";
	archiveHistory?: boolean;
	rankedHistory?: RankedHistory | undefined;
	host: () => { harness: Harness; storage: Storage };
	now: () => number;
	ensureWindow: (id: ConversationId, context: Context) => Promise<void>;
}) {
	async function conversation(id: ConversationId, context: Context) {
		const result = await options.host().harness.conversation(id, context);
		if (!result) throw new Error(`Context conversation ${id} is missing`);
		return result;
	}

	// Render only committed state. Initialization belongs to hooks and admission.
	const sections = [
		section("context", () => checkpointGuidance(options.newContextRequests)),
		section("context-state", async (input, context) => {
			const [state, hints] = await Promise.all([
				input.read.snapshot(WindowState, input.conversationId, context),
				renderNotesThreadHint(input.read, input.conversationId, context),
			]);
			const window = state?.window;
			return [
				`Current conversation ID: ${input.conversationId}. notes and history accept target with another conversation ID in this storage only when its Context visibility group matches yours. Write only your own notes.`,
				window && `Current context window UUID: ${window.id}`,
				window?.previous && `Previous context window UUID: ${window.previous}`,
				options.archiveHistory &&
					window &&
					(await renderArchiveHistoryHint(
						await conversation(input.conversationId, context),
						window.id,
						context,
					)),
				hints,
			]
				.filter(Boolean)
				.join("\n");
		}),
	];

	const remainingTool = defineTool({
		name: "get_context_remaining",
		description:
			"Active model context budget from assistant usage, with tail uncertainty",
		parameters: Type.Object({}, { additionalProperties: false }),
		replay: "safe",
		async execute(_args, api, context) {
			await options.ensureWindow(api.conversationId, context);
			const current = await conversation(api.conversationId, context);
			const usage = await contextUsage(current, options.models, context);
			const state = await api.snapshot(
				WindowState,
				api.conversationId,
				context,
			);
			const result = { ...usage, windowId: state?.window?.id ?? null };
			return {
				output: [{ type: "text", text: JSON.stringify(result) }],
				details: result,
			};
		},
	});

	async function remind(
		api: HookApi,
		context: Context,
		answer?: Parameters<typeof contextUsage>[3],
	) {
		if (options.newContextRequests === "off") return;
		if (answer) {
			const receipt = await api.snapshot(YieldAdvisory, api.taskId, context);
			if (receipt?.text) return receipt.text;
		}
		const current = await conversation(api.conversationId, context);
		const usage = await contextUsage(current, options.models, context, answer);
		const level =
			usage.percentage === null || usage.percentage < 85
				? 0
				: usage.percentage >= 90
					? 90
					: 85;
		const boundary =
			options.taskBoundaryReminderTokens > 0 &&
			usage.contextWindow !== null &&
			usage.contextWindow > 272_000 &&
			usage.usedTokens !== null &&
			usage.usedTokens >= options.taskBoundaryReminderTokens;
		if (level === 0 && !boundary) return;
		const remaining = Math.max(0, 100 - Math.round(usage.percentage ?? 0));
		const boundaryText = `Suggested context budget reached; ${remaining}% remains. For a sequence of tasks, finish the current task, save notes and call new_context before the next. Otherwise, continue here.`;
		const text = `${level === 90 ? "Urgent: " : ""}${remaining}% context remaining${usage.estimated ? " (estimated tail included)" : " (last reported usage)"}. Save the task state in notes, then call new_context ${level === 90 ? "now, before other work" : "before continuing work"}.`;
		return current.commit(async (tx) => {
			const receipt = answer
				? await tx.doc(YieldAdvisory, api.taskId)
				: undefined;
			if (receipt?.text) return receipt.text;
			const fresh = await notesAreFresh(tx, api.conversationId);
			const state = await tx.doc(WindowState, api.conversationId);
			if (!state.window) return;
			const threshold = level > 0 && !fresh && state.reminded < level;
			if (
				!threshold &&
				(!boundary || state.taskBoundaryReminded === state.window.id)
			)
				return;
			const advisory = threshold ? text : boundaryText;
			// The remark and deduplication level survive hook recovery together.
			await tx.appendEntry(api.conversationId, {
				kind: "howaboua.context.advisory",
				...(answer
					? {}
					: {
							model: [
								{
									role: "user" as const,
									content: advisory,
									timestamp: options.now(),
								},
							],
						}),
				data: { windowId: state.window.id, level, observedAt: options.now() },
			});
			if (threshold) state.reminded = level;
			else state.taskBoundaryReminded = state.window.id;
			if (receipt) receipt.text = advisory;
			return advisory;
		}, context);
	}

	const hooks = [
		hook(GenerationTask, {
			async beforeRequest(_request, api, context) {
				await options.ensureWindow(api.conversationId, context);
				if (options.rankedHistory)
					await refreshRankedHistory(
						await conversation(api.conversationId, context),
						options.rankedHistory,
						context,
					);
			},
			async afterTools(_assistant, _results, api, context) {
				await remind(api, context);
			},
			async onYield(answer, api, context) {
				if (options.rankedHistory)
					await refreshRankedHistory(
						await conversation(api.conversationId, context),
						options.rankedHistory,
						context,
					);
				const text = await remind(api, context, answer);
				return text ? { continue: text } : undefined;
			},
		}),
		hook(ToolTask, {
			async beforeTool(_call, api, context) {
				await options.ensureWindow(api.conversationId, context);
			},
			async afterTool(call, result, api, context) {
				if (
					call.name === "notes" &&
					result.isError &&
					(call.arguments["action"] === "write_file" ||
						call.arguments["action"] === "append_to_file")
				)
					await (await conversation(api.conversationId, context)).commit(
						(tx) => beginNoteWrite(tx, api.conversationId, api.taskId),
						context,
					);
			},
		}),
		hook(CompactionTask, {
			async beforeCompact(compaction) {
				return compaction.reason === "overflow" ? undefined : { decline: true };
			},
		}),
	];
	return { sections, hooks, remainingTool };
}
