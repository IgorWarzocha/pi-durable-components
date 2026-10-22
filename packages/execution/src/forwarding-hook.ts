import {
	type Harness,
	hook,
	LiveDoc,
	ToolTask,
} from "@earendil-works/pi-durable";
import {
	captureNativeCalls,
	displayResult,
	forwardCall,
} from "./forwarding.ts";
import { InvocationDoc } from "./invocation-state.ts";

/** Observe real native dispatch, including children made by a native tool's own API. */
export function forwardingHook() {
	let host: Pick<Harness, "conversation"> | undefined;
	return {
		bind(harness: Pick<Harness, "conversation">) {
			if (host !== undefined && host !== harness)
				throw new Error(
					"Create a separate execution component for each Harness",
				);
			host = harness;
		},
		hook: hook(ToolTask, {
			async beforeTool(call, api, context) {
				const parent = call.parent;
				if (parent === undefined || host === undefined) return;
				const source = await api.snapshot(
					InvocationDoc,
					parent.taskId,
					context,
				);
				const cellId = source?.forwardingCellId;
				if (cellId === undefined) return;
				const conversation = await host.conversation(
					api.conversationId,
					context,
				);
				if (conversation === undefined)
					throw new Error("Forwarded call conversation is unavailable");
				await conversation.commit(async (tx) => {
					if ((await tx.task(api.taskId))?.kind !== ToolTask.definition.name)
						return;
					const owner = await tx.doc(InvocationDoc, api.taskId);
					const admission = owner.forwardingCellId === undefined;
					owner.forwardingCellId = cellId;
					await forwardCall(
						tx,
						cellId,
						{
							callId: call.id,
							parentCallId: parent.callId,
							name: call.name,
							arguments: call.arguments,
							status: "pending",
							result: null,
							omittedFields: [],
						},
						admission,
						{ taskId: api.taskId, ownerTaskId: parent.taskId },
					);
				}, context);
			},
			async afterTool(call, result, api, context) {
				const parent = call.parent;
				if (parent === undefined || host === undefined) return;
				const source = await api.snapshot(InvocationDoc, api.taskId, context);
				if (source?.forwardingCellId === undefined) return;
				const conversation = await host.conversation(
					api.conversationId,
					context,
				);
				if (conversation === undefined)
					throw new Error("Forwarded call conversation is unavailable");
				await conversation.commit(async (tx) => {
					if ((await tx.task(api.taskId))?.kind !== ToolTask.definition.name)
						return;
					const owner = await tx.doc(InvocationDoc, api.taskId);
					const cellId = owner.forwardingCellId;
					if (cellId === undefined) return;
					await captureNativeCalls(tx, api.conversationId, api.taskId, cellId);
					const slot = (
						await tx.doc(LiveDoc, api.conversationId)
					).nestedTools?.find((slot) => slot.callId === call.id);
					const cell = await tx.doc(InvocationDoc, cellId);
					await forwardCall(tx, cellId, {
						callId: call.id,
						parentCallId: parent.callId,
						name: call.name,
						arguments: slot?.arguments ?? call.arguments,
						status: "completed",
						result: displayResult(result, cell.forwardingBudget ?? 40000),
						omittedFields: [],
					});
				}, context);
			},
		}),
	};
}
