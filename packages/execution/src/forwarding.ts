import { copyJson, type JsonRepresentation } from "@earendil-works/chord";
import {
	type ConversationId,
	LiveDoc,
	NestedCallDoc,
	type TaskId,
	type ToolExecutionResult,
	ToolTask,
	type Tx,
} from "@earendil-works/pi-durable";
import type {
	ForwardedToolCall,
	ForwardedToolCalls,
	ForwardedToolStatus,
} from "./forwarded-tools.ts";
import { InvocationDoc } from "./invocation-state.ts";
import { boundOutput } from "./output.ts";
import type { ExecutionResultReceipt } from "./presentation.ts";

const bytes = (value: unknown) =>
	new TextEncoder().encode(JSON.stringify(value)).length;

/** The budget applies only to display copies, never invocation inputs or runtime results. */
export function boundForwardedToolCalls(
	value: ForwardedToolCalls,
	budget: number,
): ForwardedToolCalls {
	const calls: ForwardedToolCall[] = [];
	let remaining = budget;
	let omittedCalls = value.omittedCalls;
	for (const source of value.calls) {
		let call = source;
		if (bytes(call) > remaining && call.result !== null) {
			call = {
				...call,
				result: null,
				omittedFields: [...call.omittedFields, "result"],
			};
		}
		if (bytes(call) > remaining && call.arguments !== undefined) {
			const { arguments: _arguments, ...rest } = call;
			call = { ...rest, omittedFields: [...call.omittedFields, "arguments"] };
		}
		const cost = bytes(call);
		if (cost > remaining) omittedCalls++;
		else {
			calls.push(call);
			remaining -= cost;
		}
	}
	return { ...value, calls, omittedCalls };
}

export function displayResult(
	result: ToolExecutionResult,
	budget: number,
): ExecutionResultReceipt {
	let remaining = budget;
	let omitted = false;
	const content: ExecutionResultReceipt["content"][number][] = [];
	for (const item of result.output ?? []) {
		if (item.type === "image") {
			const cost = bytes(item);
			if (cost <= remaining) {
				content.push(item);
				remaining -= cost;
			} else omitted = true;
		} else {
			const bounded = boundOutput(item.text, {
				maxBytes: remaining,
				maxLines: Number.MAX_SAFE_INTEGER,
				retain: "head",
			});
			if (bounded.text) content.push({ type: "text", text: bounded.text });
			remaining -= bounded.bytes;
			omitted ||= bounded.droppedBytes > 0;
		}
	}
	return {
		content,
		isError: result.isError ?? false,
		details: result.details ?? null,
		diagnostics: [
			...(result.diagnostics ?? []),
			...(omitted
				? [
						{
							severity: "warn" as const,
							code: "forwarded_display_truncated",
							message:
								"Forwarded display output was truncated; the original tool result is unchanged",
						},
					]
				: []),
		],
	};
}

export function forwardedStatus(
	result: ToolExecutionResult,
	fallback: ForwardedToolStatus,
): ForwardedToolStatus {
	if (result.diagnostics?.some((item) => item.code === "interrupted"))
		return "interrupted";
	if (
		result.diagnostics?.some(
			(item) => item.code === "aborted" || item.code === "abandoned",
		)
	)
		return "aborted";
	return fallback;
}

/** Update the current cell's existing receipt; no transcript entry or parallel history. */
export async function forwardCall(
	tx: Tx,
	cellId: TaskId | undefined,
	call: ForwardedToolCall,
	admission = false,
	nativeTask?: { taskId: TaskId; ownerTaskId: TaskId },
): Promise<void> {
	if (cellId === undefined) return;
	const doc = await tx.doc(InvocationDoc, cellId);
	const snapshot = doc.forwardedToolCalls;
	if (snapshot === undefined) return;
	const position = snapshot.calls.findIndex(
		(item) => item.callId === call.callId,
	);
	if (position === -1 && !admission) return;
	const calls: ForwardedToolCall[] = [...snapshot.calls];
	if (position === -1) calls.push(call);
	else calls[position] = call;
	doc.forwardedToolCalls = copyJson(
		boundForwardedToolCalls(
			{ ...snapshot, calls },
			doc.forwardingBudget ?? 40000,
		),
		{ omitUndefinedProperties: true },
	) as JsonRepresentation<ForwardedToolCalls>;
	const retained = new Set(
		doc.forwardedToolCalls.calls.map((item) => item.callId),
	);
	if (doc.forwardedNativeTasks !== undefined)
		doc.forwardedNativeTasks = doc.forwardedNativeTasks.filter((item) =>
			retained.has(item.callId),
		);
	if (
		nativeTask !== undefined &&
		retained.has(call.callId) &&
		!doc.forwardedNativeTasks?.some((item) => item.callId === call.callId)
	) {
		doc.forwardedNativeTasks ??= [];
		doc.forwardedNativeTasks.push({ callId: call.callId, ...nativeTask });
	}
}

export async function forwardInvocationResult(
	tx: Tx,
	taskId: TaskId,
	result: ToolExecutionResult,
	status: ForwardedToolStatus,
): Promise<void> {
	const cellId = (await tx.doc(InvocationDoc, taskId)).forwardingCellId;
	if (cellId === undefined || cellId === taskId) return;
	const doc = await tx.doc(InvocationDoc, cellId);
	const previous = doc.forwardedToolCalls?.calls.find(
		(call) => call.callId === `nested-${taskId}`,
	);
	if (previous === undefined) return;
	await forwardCall(tx, cellId, {
		...previous,
		status: forwardedStatus(result, status),
		result: displayResult(result, doc.forwardingBudget ?? 40000),
		omittedFields: previous.omittedFields.filter((field) => field !== "result"),
	});
}

/** Acquire native progress/results while the caller's task-scoped receipts still exist. */
export async function captureNativeCalls(
	tx: Tx,
	conversationId: ConversationId,
	owner: TaskId,
	cellId: TaskId | undefined,
): Promise<void> {
	if (cellId === undefined) return;
	const live = await tx.doc(LiveDoc, conversationId);
	const owners = new Set<TaskId>([owner]);
	const cell = await tx.doc(InvocationDoc, cellId);
	const budget = cell.forwardingBudget ?? 40000;
	const admitted = new Set(
		cell.forwardedToolCalls?.calls.map((call) => call.callId),
	);
	for (const slot of live.nestedTools ?? []) {
		if (!owners.has(slot.parentTaskId) && !admitted.has(slot.callId)) continue;
		owners.add(slot.taskId);
		const key = slot.callId.slice(slot.parentCallId.length + 1);
		const stored = (await tx.doc(NestedCallDoc, slot.parentTaskId, key, null))
			.result;
		const record = await tx.task(slot.taskId);
		const outcome =
			record?.state.status === "terminal" ? record.state.outcome : undefined;
		const previous = cell.forwardedToolCalls?.calls.find(
			(call) => call.callId === slot.callId,
		);
		// afterTool precedes native settlement; an older running slot must not replace its receipt.
		if (
			stored === undefined &&
			previous !== undefined &&
			previous.status !== "pending" &&
			previous.status !== "running"
		)
			continue;
		const captured =
			previous !== undefined &&
			previous.status !== "pending" &&
			previous.status !== "running" &&
			!previous.result?.diagnostics.some(
				(item) => item.code === "forwarded_output_unavailable",
			);
		const terminal =
			stored !== undefined || outcome !== undefined || slot.status === "done";
		const result: ToolExecutionResult = stored ?? {
			...(slot.output === undefined
				? {}
				: { output: [{ type: "text", text: slot.output }] }),
			...(slot.details === undefined ? {} : { details: slot.details }),
			...(slot.diagnostics === undefined
				? {}
				: { diagnostics: slot.diagnostics }),
		};
		const receipt: ExecutionResultReceipt =
			stored === undefined
				? displayResult(result, budget)
				: {
						content: previous?.result?.content ?? [],
						isError: stored.isError,
						details: stored.details ?? null,
						diagnostics: [
							...stored.diagnostics,
							...(!captured
								? [
										{
											severity: "warn" as const,
											code: "forwarded_output_unavailable",
											message:
												"Native display output was not retained. Bind this execution component to its owning Harness before running native nested calls",
										},
									]
								: []),
						],
					};
		await forwardCall(tx, cellId, {
			callId: slot.callId,
			parentCallId: slot.parentCallId,
			name: slot.name,
			arguments: slot.arguments,
			status: terminal
				? forwardedStatus(
						result,
						outcome?.status === "aborted"
							? "aborted"
							: outcome?.status === "completed"
								? "completed"
								: "failed",
					)
				: slot.status === "pending"
					? "pending"
					: "running",
			result:
				terminal && previous?.omittedFields.includes("result") ? null : receipt,
			omittedFields:
				terminal && previous?.omittedFields.includes("result")
					? ["result"]
					: [],
		});
	}
	// Durable removes a native parent's slots after aborting its unfinished descendants.
	// Those aborts bypass afterTool, including while no exec/wait observer is attached.
	const visible = new Set(live.nestedTools?.map((slot) => slot.callId));
	for (const admitted of [...(cell.forwardedNativeTasks ?? [])]) {
		if (visible.has(admitted.callId)) continue;
		const record = await tx.task(admitted.taskId);
		if (
			record === undefined ||
			record.kind !== ToolTask.definition.name ||
			record.owner !== admitted.ownerTaskId ||
			record.conversationId !== conversationId
		)
			throw new Error(
				`Native forwarded task ${admitted.taskId} does not match its admission`,
			);
		if (record.state.status !== "terminal") continue;
		const call = cell.forwardedToolCalls?.calls.find(
			(item) => item.callId === admitted.callId,
		);
		if (call !== undefined) {
			const outcome = record.state.outcome;
			const unfinished = call.status === "pending" || call.status === "running";
			// Task completion does not turn a captured tool-error result into success.
			const completedStatus = unfinished
				? forwardedStatus(
						{ diagnostics: call.result?.diagnostics ?? [] },
						call.result?.isError ? "failed" : "completed",
					)
				: call.status;
			const status =
				record.abortReason === "restart"
					? "interrupted"
					: outcome.status === "completed"
						? completedStatus
						: outcome.status === "aborted"
							? "aborted"
							: "failed";
			if (unfinished || call.status !== status) {
				const diagnostic =
					status === "completed"
						? {
								severity: "warn" as const,
								code: "forwarded_result_unavailable",
								message:
									"Native task completed, but its final display result was not retained; the retained output may be partial",
							}
						: {
								severity: "error" as const,
								code: status,
								message: `Native tool ${call.name} ${status}; external side effects may have partially run`,
							};
				await forwardCall(tx, cellId, {
					...call,
					status,
					result: call.omittedFields.includes("result")
						? null
						: {
								content: call.result?.content ?? [],
								isError:
									status === "completed"
										? (call.result?.isError ?? false)
										: true,
								details: call.result?.details ?? null,
								diagnostics: [...(call.result?.diagnostics ?? []), diagnostic],
							},
				});
			}
		}
		cell.forwardedNativeTasks =
			cell.forwardedNativeTasks?.filter(
				(item) => item.callId !== admitted.callId,
			) ?? [];
	}
}
