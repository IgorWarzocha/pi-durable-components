import type { Context } from "@earendil-works/chord";
import type {
	ConversationAbortOptions,
	ConversationId,
	ConversationRecord,
	TaskId,
} from "@earendil-works/pi-durable";
import { LiveDoc } from "@earendil-works/pi-durable";
import type { AgentRecord } from "./state.ts";
import { Fleet } from "./state.ts";
import type { AgentsBinding } from "./watch.ts";

/** Controller is delegation metadata; owner is Durable's native ownership edge. */
export type AgentObservation = AgentRecord & {
	owner?: NonNullable<ConversationRecord["owner"]>;
	state: { status: "idle" } | { status: "working"; run: TaskId };
};

export type AgentMessage = {
	target: ConversationId;
	sender: ConversationId;
	message: string;
	/** Stable per host operation, including retries after uncertain outcomes. */
	requestId: string;
};

/** Host authorization stays with the caller; controls only admit registered workers. */
export function createHostAccess(binding: () => AgentsBinding) {
	async function worker(target: ConversationId, context: Context) {
		const { harness } = binding();
		const fleet = await harness.snapshot(Fleet, context);
		if (fleet?.agents[String(target)] === undefined)
			throw new Error(`No registered worker ${target}`);
		const conversation = await harness.conversation(target, context);
		if (conversation === undefined)
			throw new Error(`Missing worker conversation ${target}`);
		return conversation;
	}
	return {
		/** Point-in-time reads, not an atomic frame. Observe changes through native Harness watches. */
		async roster(context: Context): Promise<AgentObservation[]> {
			const { harness, storage } = binding();
			const fleet = await harness.snapshot(Fleet, context);
			return Promise.all(
				Object.values(fleet?.agents ?? {}).map(async (agent) => {
					const record = await storage.conversation(agent.target, context);
					if (record === undefined)
						throw new Error(`Missing worker conversation ${agent.target}`);
					const live = await harness.snapshot(LiveDoc, agent.target, context);
					return {
						...agent,
						...(record.owner === undefined ? {} : { owner: record.owner }),
						state:
							live?.run === undefined
								? { status: "idle" as const }
								: { status: "working" as const, run: live.run.taskId },
					};
				}),
			);
		},
		async stop(
			target: ConversationId,
			context: Context,
			options?: ConversationAbortOptions,
		) {
			await (await worker(target, context)).abort(context, options);
		},
		async message(input: AgentMessage, context: Context) {
			if (!input.message.trim()) throw new Error("message must not be blank");
			if (!input.requestId.trim())
				throw new Error("requestId must not be blank");
			const { harness } = binding();
			if ((await harness.conversation(input.sender, context)) === undefined)
				throw new Error(`Missing sender conversation ${input.sender}`);
			return (await worker(input.target, context)).submit(
				{
					type: "input",
					content: `[Message from conversation ${input.sender}]\n${input.message}`,
					whenBusy: "steer",
					requestId: input.requestId,
				},
				context,
			);
		},
	};
}
