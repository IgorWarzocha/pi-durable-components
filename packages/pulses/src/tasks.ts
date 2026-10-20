import type { Context } from "@earendil-works/chord";
import {
	ConversationBusy,
	defineTask,
	type Harness,
	LiveDoc,
	type SettledSubmissionRecord,
	type TaskId,
} from "@earendil-works/pi-durable";
import type {
	PulseBinding,
	PulseOccurrence,
	PulseOutcome,
	PulsesOptions,
	PulseTrigger,
} from "./contract.ts";
import type { PulseDefinition } from "./definitions.ts";
import type { PulseReference } from "./state.ts";

const completed = {
	status: "terminal",
	outcome: { status: "completed", result: null },
} as const;
const aborted = { status: "terminal", outcome: { status: "aborted" } } as const;
const resultGuidance =
	"Use appropriate available tools or destinations for substantive task results and logs. Your final assistant message to the main agent should briefly confirm completion and point to the outcome, without repeating it. Report failures, ambiguities or suggested improvements to the pulse procedure only in that final assistant message, separately from the completion summary. Do not put this procedural feedback in task logs, notes or boards. Do not edit the pulse definition unless its instructions explicitly authorise it.";
export const Anchor = defineTask<null, { phase: "done" }, null>({
	name: "howaboua.pulses.anchor",
	version: 1,
	initial: () => ({ phase: "done" }),
	phases: {
		done: (_task, runtime, context) => runtime.commit(() => completed, context),
	},
	abort: (_task, runtime, context) => runtime.commit(() => aborted, context),
});

export type PulseRunInput = {
	binding: PulseBinding;
	definition: PulseDefinition;
	reference: PulseReference;
	trigger: PulseTrigger;
	requestId: string;
	/** Absent on native tasks admitted before missed-period tracking. */
	occurrence?: PulseOccurrence;
};
type RunState =
	| { phase: "dispatch" }
	| { phase: "retry"; after: number }
	| { phase: "deliver"; outcome: SettledSubmissionRecord };
export const pulseInputRequestId = (taskId: TaskId) => `pulse-input:${taskId}`;

export function createRunTask(host: () => Harness, options: PulsesOptions) {
	return defineTask<PulseRunInput, RunState, SettledSubmissionRecord>({
		name: "howaboua.pulses.run",
		version: 1,
		initial: () => ({ phase: "dispatch" }),
		phases: {
			dispatch: async (task, runtime, context) => {
				const conversation = await runtime.conversation(
					task.input.reference.conversationId,
					context,
				);
				if (!conversation) throw new Error("Missing pulse conversation");
				const { definition, trigger, occurrence } = task.input;
				const period = occurrence
					? `\nScheduled occurrences coalesced: ${occurrence.count}. Period: ${new Date(occurrence.startAt).toISOString()} through ${new Date(occurrence.endAt).toISOString()}. Cover relevant work since the start of this period in one fresh run; do not replay each occurrence.`
					: "";
				const content = `[Pulse: ${definition.title}; ${trigger}]\nWorkspace: ${definition.root}\nPulse home: ${definition.pulseHome}\nDefinition: ${definition.path}${period}\nBefore work, read applicable instructions including ${definition.pulseHome}/AGENTS.md if present. Preserve the pulse folder and use its existing journal/artifact conventions.\n\n${definition.body}\n\n${resultGuidance}`;
				const requestId = pulseInputRequestId(task.id);
				const outcome = await (async () => {
					// Native receipt rejoin precedes even the host delivery port and its policy.
					const previous = await host().commit(
						(tx) =>
							tx.submissionByRequest(
								task.input.reference.conversationId,
								requestId,
							),
						context,
					);
					if (previous) {
						const submission = await host().submission(previous.id, context);
						if (!submission)
							throw new Error("Missing admitted pulse submission");
						return submission.wait(context);
					}
					if (options.submitInput)
						return options.submitInput(
							{
								conversationId: task.input.reference.conversationId,
								taskId: task.id,
								requestId,
								content,
							},
							context,
						);
					const submission = await conversation.submit(
						{ type: "input", requestId, whenBusy: "reject", content },
						context,
					);
					return submission.wait(context);
				})().catch(async (error) => {
					if (!(error instanceof ConversationBusy)) throw error;
					// Native reject admitted nothing. Retain exactly this one responsibility while external work clears.
					await runtime.commit(
						() => ({
							status: "running",
							checkpoint: { phase: "retry", after: runtime.now() + 5_000 },
						}),
						context,
					);
					return undefined;
				});
				if (!outcome) return;
				if (
					outcome.type !== "input" ||
					outcome.requestId !== requestId ||
					outcome.conversationId !== task.input.reference.conversationId
				)
					throw new Error(
						"Pulse delivery returned a different native input receipt",
					);
				await runtime.commit(
					() => ({
						status: "running",
						checkpoint: { phase: "deliver", outcome },
					}),
					context,
				);
			},
			retry: async (task, runtime, context) => {
				await runtime.sleep(task.state.checkpoint.after, context);
				await runtime.commit(
					() => ({ status: "running", checkpoint: { phase: "dispatch" } }),
					context,
				);
			},
			deliver: async (task, runtime, context) => {
				const outcome = task.state.checkpoint.outcome;
				const parentConversationId = task.input.reference.parentConversationId;
				if (parentConversationId !== undefined) {
					const delivery = {
						parentConversationId,
						conversationId: task.input.reference.conversationId,
						taskId: task.id,
						outcome,
						requestId: `pulse-result:${task.id}`,
						title: task.input.definition.title,
						text: await resultText(host(), outcome, context),
						...(task.input.occurrence
							? { occurrence: task.input.occurrence }
							: {}),
					};
					const receipt =
						(await runtime.memo<SettledSubmissionRecord>(
							"passive-receipt",
							context,
						)) ??
						(options.writeResult
							? await options.writeResult(delivery, context)
							: await passiveResult(host(), delivery, context));
					if (
						receipt.type !== "write" ||
						receipt.status !== "done" ||
						receipt.requestId !== delivery.requestId ||
						receipt.conversationId !== parentConversationId
					)
						throw new Error(
							`Pulse passive delivery did not settle: ${receipt.status}`,
						);
					await runtime.memo("passive-receipt", receipt, context);
				}
				await runtime.commit(
					() => ({
						status: "terminal",
						outcome: { status: "completed", result: outcome },
					}),
					context,
				);
			},
		},
		abort: async (task, runtime, context) => {
			const harness = host();
			const { native, run } = await harness.commit(async (tx) => {
				const native = await tx.submissionByRequest(
					task.input.reference.conversationId,
					`pulse-input:${task.id}`,
				);
				const live = await tx.doc(LiveDoc, task.input.reference.conversationId);
				return {
					native: native === undefined ? undefined : { ...native },
					run:
						native?.status === "placed" && live.run?.inputs.includes(native.id)
							? live.run.taskId
							: undefined,
				};
			}, context);
			// Cancel only the run that owns this input, never external work blocking a retry or following settlement.
			if (run !== undefined) {
				await harness.abortTask(run, context);
				await harness.waitForTask(run, context);
			}
			let outcome: PulseOutcome = { status: "aborted" };
			if (native !== undefined) {
				const submission = await harness.submission(native.id, context);
				if (!submission) throw new Error("Missing aborted pulse submission");
				outcome = await submission.wait(context);
			}
			const parentConversationId = task.input.reference.parentConversationId;
			if (parentConversationId !== undefined) {
				const delivery = {
					parentConversationId,
					conversationId: task.input.reference.conversationId,
					taskId: task.id,
					outcome,
					title: task.input.definition.title,
					text: await resultText(harness, outcome, context),
					requestId: `pulse-result:${task.id}`,
					...(task.input.occurrence
						? { occurrence: task.input.occurrence }
						: {}),
				};
				const receipt =
					(await runtime.memo<SettledSubmissionRecord>(
						"passive-receipt",
						context,
					)) ??
					(options.writeResult
						? await options.writeResult(delivery, context)
						: await passiveResult(harness, delivery, context));
				if (
					receipt.type !== "write" ||
					receipt.status !== "done" ||
					receipt.requestId !== delivery.requestId ||
					receipt.conversationId !== parentConversationId
				)
					throw new Error("Aborted pulse passive delivery did not settle");
				await runtime.memo("passive-receipt", receipt, context);
			}
			await runtime.commit(() => aborted, context);
		},
	});
}

async function passiveResult(
	harness: Harness,
	delivery: Parameters<NonNullable<PulsesOptions["writeResult"]>>[0],
	context: Context,
) {
	const parent = await harness.conversation(
		delivery.parentConversationId,
		context,
	);
	if (!parent) throw new Error("Missing pulse result recipient");
	const text = `[Pulse result: ${delivery.title}; conversation ${delivery.conversationId}; task ${delivery.taskId}; ${delivery.outcome.status}]\n${delivery.text}`;
	const submission = await parent.submit(
		{
			type: "write",
			requestId: delivery.requestId,
			entry: {
				kind: "howaboua.pulses.result",
				data: delivery,
				model: [{ role: "user", content: text, timestamp: Date.now() }],
			},
		},
		context,
	);
	return submission.wait(context);
}

async function resultText(
	harness: Harness,
	outcome: PulseOutcome,
	context: Context,
): Promise<string> {
	if (
		!("type" in outcome) ||
		outcome.type !== "input" ||
		outcome.status !== "done"
	)
		return JSON.stringify(outcome);
	const answer = outcome.answer;
	const entry = await harness.commit((tx) => tx.entry(answer), context);
	if (!entry) throw new Error(`Missing pulse answer ${answer}`);
	return (entry.model ?? [])
		.filter((message) => message.role === "assistant")
		.flatMap((message) =>
			typeof message.content === "string"
				? [message.content]
				: message.content.flatMap((part) =>
						part.type === "text" ? [part.text] : [],
					),
		)
		.join("\n");
}
