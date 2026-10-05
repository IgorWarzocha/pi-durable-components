import type { Context } from "@earendil-works/chord";
import type {
	Harness,
	HookApi,
	HookRegistration,
} from "@earendil-works/pi-durable";
import { GenerationTask, hook } from "@earendil-works/pi-durable";
import {
	BoardNoticeReceipt,
	BoardNotices,
	receiveBoardNotices,
} from "./notices.ts";

async function receive(
	binding: () => { harness: Harness },
	api: HookApi,
	at: "beforeRequest" | "onYield",
	context: Context,
) {
	const [notices, receipt] = await Promise.all([
		api.snapshot(BoardNotices, api.conversationId, context),
		api.snapshot(BoardNoticeReceipt, api.taskId, context),
	]);
	// Selecting agents without a bound board must keep ordinary delegation working.
	if (Object.keys(notices?.pending ?? {}).length === 0 && receipt?.[at] == null)
		return undefined;
	return binding().harness.commit(
		(tx) => receiveBoardNotices(tx, api, at),
		context,
	);
}

/** Public generation hooks deliver notices without putting turn-bound work in the native inbox. */
export function createBoardNoticeHooks(
	binding: () => { harness: Harness },
): HookRegistration[] {
	return [
		hook(GenerationTask, {
			beforeRequest: async (request, api, context) => {
				const notice = await receive(binding, api, "beforeRequest", context);
				if (
					notice === undefined ||
					request.messages.some(
						(message) =>
							message.role === "user" && message.content === notice.content,
					)
				)
					return undefined;
				// The native request has a captured cutoff. The appended entry is beyond it.
				return {
					messages: [
						...request.messages,
						{
							role: "user",
							content: notice.content,
							timestamp: notice.timestamp,
						},
					],
				};
			},
			onYield: async (_answer, api, context) => {
				const notice = await receive(binding, api, "onYield", context);
				// Native onYield keeps the original run inputs while handing generation over.
				return notice === undefined ? undefined : { continue: notice.content };
			},
		}),
	];
}
