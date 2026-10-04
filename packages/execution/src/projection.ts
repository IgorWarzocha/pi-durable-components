import type { Message } from "@earendil-works/pi-ai";
import { GenerationTask, hook } from "@earendil-works/pi-durable";

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
	const visible = new Set(surfaceTools);
	return hook(GenerationTask, {
		beforeRequest: (request) => ({
			messages: projectToolSchemas(request.messages, visible),
		}),
	});
}
