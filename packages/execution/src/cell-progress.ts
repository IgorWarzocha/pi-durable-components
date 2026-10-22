import { type Context, copyJson } from "@earendil-works/chord";
import {
	LiveDoc,
	type TaskId,
	type ToolExecutionApi,
	type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { CellStateDoc } from "./cell-observation.ts";
import { boundForwardedToolCalls, captureNativeCalls } from "./forwarding.ts";
import { InvocationDoc, type InvocationState } from "./invocation-state.ts";

/** The observer owns subscriptions and in-flight callbacks until exec/wait returns. */
export async function observeCellProgress(
	id: TaskId<ToolExecutionResult>,
	api: ToolExecutionApi,
	context: Context,
	budget: number,
) {
	const pending = new Set<Promise<void>>();
	const publish = async (
		value: Readonly<InvocationState> | null | undefined,
	) => {
		if (value?.forwardedToolCalls === undefined) return;
		await api.details(
			{
				cell_id: String(id),
				status: "running",
				forwardedToolCalls: copyJson(
					boundForwardedToolCalls(value.forwardedToolCalls, budget),
					{ omitUndefinedProperties: true },
				),
			},
			context,
		);
	};
	const cell = await api.watchDoc(InvocationDoc, id, context);
	if (cell === undefined) {
		await publish(
			await api.snapshot(CellStateDoc, api.conversationId, String(id), context),
		);
		return async () => {};
	}
	const own = (action: () => Promise<void>) => {
		const work = action();
		pending.add(work);
		work.then(
			() => pending.delete(work),
			() => pending.delete(work),
		);
		return work;
	};
	const live = await api.watchDoc(LiveDoc, api.conversationId, context);
	cell.start((value) => own(() => publish(value)));
	live?.start(() =>
		own(async () => {
			await api.commit(async (tx) => {
				const record = await tx.task(id);
				if (record === undefined || record.state.status === "terminal") return;
				await captureNativeCalls(tx, api.conversationId, id, id);
			}, context);
		}),
	);
	try {
		await publish(cell.value);
	} catch (error) {
		await cell.stop();
		await live?.stop();
		await Promise.allSettled([...pending]);
		throw error;
	}
	return async () => {
		const endings = await Promise.all([cell.stop(), live?.stop()]);
		await Promise.all([...pending]);
		for (const ending of endings)
			if (ending?.reason === "listener_error") throw ending.error;
	};
}
