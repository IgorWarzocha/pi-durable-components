import type { Message } from "@earendil-works/pi-ai";
import { GenerationTask, type Harness, hook } from "@earendil-works/pi-durable";
import { readToolContract } from "./tool-contract.ts";

/** Project request-local schema deltas. Agent selection and stored entries remain untouched. */
function projectToolSchemas(
	messages: readonly Message[],
	visible: ReadonlySet<string>,
): readonly Message[] {
	return messages.map((message) =>
		message.role !== "system"
			? message
			: {
					...message,
					...(message.toolsAdded === undefined
						? {}
						: {
								toolsAdded: message.toolsAdded.filter((tool) =>
									visible.has(tool.name),
								),
							}),
					...(message.toolsRemoved === undefined
						? {}
						: {
								toolsRemoved: message.toolsRemoved.filter((tool) =>
									visible.has(tool.name),
								),
							}),
				},
	);
}

export function providerProjection(surfaceTools: readonly string[]) {
	let host: Pick<Harness, "conversation"> | undefined;
	return {
		// Durable strips registration metadata from transcript declarations. Hooks have
		// no agent resolver, so the host must explicitly provide its public Harness.
		bind(harness: Pick<Harness, "conversation">): void {
			if (host !== undefined && host !== harness)
				throw new Error(
					"Create a separate execution component for each Harness",
				);
			host = harness;
		},
		hook: hook(GenerationTask, {
			beforeRequest: async (request, api, context) => {
				const visible = new Set(surfaceTools);
				if (host !== undefined) {
					const conversation = await host.conversation(
						api.conversationId,
						context,
					);
					if (conversation === undefined)
						throw new Error(
							`Conversation ${api.conversationId} is unavailable`,
						);
					for (const tool of (await conversation.agent(context)).tools)
						if (readToolContract(tool).nativeOnly) visible.add(tool.name);
				}
				return { messages: projectToolSchemas(request.messages, visible) };
			},
		}),
	};
}
