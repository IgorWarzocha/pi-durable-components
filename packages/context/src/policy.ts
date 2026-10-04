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
import { notesAreFresh, renderNotesThreadHint } from "./note-store.ts";
import { contextUsage } from "./usage.ts";
import { WindowState } from "./window-state.ts";

const checkpoint =
	"Before rollover, save the active request, decisions, progress, useful history IDs and next steps in notes, then call new_context. Include useful deferred work without treating it as permission to implement. After rollover, read the hinted notes and use history only for a missing detail.";

// Durable's onYield continuation creates a successor GenerationTask. A task receipt
// repeats the same answer's decision on recovery, not subsequent answers' decisions.
const YieldAdvisory = defineDoc<{ text?: string }>({
	kind: "howaboua.context.yield-advisory",
	version: 1,
	scope: "task",
	initial: () => ({}),
});

export function createContextPolicy(options: {
	models: Models;
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
		section("context", async (input, context) => {
			const [state, hints] = await Promise.all([
				input.read.snapshot(WindowState, input.conversationId, context),
				renderNotesThreadHint(input.read, input.conversationId, context),
			]);
			const window = state?.window;
			return [
				checkpoint,
				window && `Current context window UUID: ${window.id}`,
				window?.previous && `Previous context window UUID: ${window.previous}`,
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
				content: [{ type: "text", text: JSON.stringify(result) }],
				details: result,
			};
		},
	});

	async function remind(
		api: HookApi,
		context: Context,
		answer?: Parameters<typeof contextUsage>[3],
	) {
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
		if (level === 0) return;
		const text = `Context usage is ${Math.round(usage.percentage ?? 0)}%${usage.estimated ? " (estimated tail included)" : " (last reported usage)"}. ${checkpoint}`;
		return current.commit(async (tx) => {
			const receipt = answer
				? await tx.doc(YieldAdvisory, api.taskId)
				: undefined;
			if (receipt?.text) return receipt.text;
			const fresh = await notesAreFresh(tx, api.conversationId);
			const state = await tx.doc(WindowState, api.conversationId);
			if (!state.window || fresh || state.reminded >= level) return;
			// The remark and deduplication level survive hook recovery together.
			await tx.appendEntry(api.conversationId, {
				kind: "howaboua.context.advisory",
				...(answer
					? {}
					: {
							model: [
								{
									role: "user" as const,
									content: text,
									timestamp: options.now(),
								},
							],
						}),
				data: { windowId: state.window.id, level, observedAt: options.now() },
			});
			state.reminded = level;
			if (receipt) receipt.text = text;
			return text;
		}, context);
	}

	const hooks = [
		hook(GenerationTask, {
			async beforeRequest(_request, api, context) {
				await options.ensureWindow(api.conversationId, context);
			},
			async afterTools(_assistant, _results, api, context) {
				await remind(api, context);
			},
			async onYield(answer, api, context) {
				const text = await remind(api, context, answer);
				return text ? { continue: text } : undefined;
			},
		}),
		hook(ToolTask, {
			async beforeTool(_call, api, context) {
				await options.ensureWindow(api.conversationId, context);
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
