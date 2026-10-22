import type { Context } from "@earendil-works/chord";
import type {
	Harness,
	HookApi,
	HookRegistration,
} from "@earendil-works/pi-durable";
import { GenerationTask, hook } from "@earendil-works/pi-durable";
import { prepareBoardCatchup } from "./awareness.ts";
import {
	activeBoardRun,
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
	// An unbound component with no pending delivery has no host work to perform.
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
	catchupBinding: () => { harness: Harness } | undefined,
): HookRegistration[] {
	return [
		hook(GenerationTask, {
			beforeRequest: async (request, api, context) => {
				const host = catchupBinding();
				const [notice, catchup] =
					host === undefined
						? [await receive(binding, api, "beforeRequest", context), undefined]
						: await host.harness.commit(async (tx) => {
								const run = await activeBoardRun(tx, api.conversationId);
								if (run?.taskId !== api.taskId)
									return [undefined, undefined] as const;
								// Deliver and mark notices seen before querying the same archive frame.
								const notice = await receiveBoardNotices(
									tx,
									api,
									"beforeRequest",
								);
								const catchup = await prepareBoardCatchup(tx, api);
								return [notice, catchup] as const;
							}, context);
				const additions = [
					notice === undefined
						? undefined
						: { role: "user" as const, ...notice },
					catchup,
				]
					.filter((item) => item !== undefined)
					.filter(
						(item) =>
							!request.messages.some(
								(message) =>
									message.role === item.role &&
									message.content === item.content &&
									message.timestamp === item.timestamp,
							),
					);
				if (additions.length === 0) return undefined;
				// The native request has a captured cutoff. The appended entry is beyond it.
				return {
					messages: [
						...request.messages,
						...additions.map(
							(item) =>
								({
									role: item.role,
									content: item.content,
									timestamp: item.timestamp,
								}) as const,
						),
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
