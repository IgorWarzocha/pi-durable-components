import type { Context, JsonValue } from "@earendil-works/chord";
import type {
	ConversationId,
	Cursor,
	EntryId,
	Harness,
	TaskId,
} from "@earendil-works/pi-durable";
import { MAX_CODE_MODE_OUTPUT_TOKENS } from "./exec-source.ts";
import type {
	ForwardedToolCall,
	ForwardedToolCalls,
} from "./forwarded-tools.ts";
import { boundForwardedToolCalls, forwardedStatus } from "./forwarding.ts";
import { NestedResultEntry } from "./nested-result.ts";
import { parseExecutionResultReceipt } from "./presentation.ts";

export interface ExecutionHistoryRequest {
	readonly conversationId: ConversationId;
	readonly cellIds: readonly string[];
	readonly maxOutputTokens?: number;
}

type HistoryHarness = Pick<Harness, "conversation" | "getTask" | "commit">;

function object(value: JsonValue | undefined): { [key: string]: JsonValue } {
	if (
		value === null ||
		value === undefined ||
		typeof value !== "object" ||
		Array.isArray(value)
	)
		throw new TypeError("Invalid historical execution record");
	return value;
}

function taskId(value: string): TaskId {
	const id = Number(value);
	if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(id))
		throw new TypeError("Invalid historical execution cell ID");
	return id as TaskId;
}

/** Verified retained direct calls only, not a reconstructed native descendant graph.
 * Current fork-visible history excludes later results from the parent conversation.
 */
export function executionHistory(mode: "notebook" | "code" | "worker-code") {
	return async function readForwardedToolCalls(
		harness: HistoryHarness,
		request: ExecutionHistoryRequest,
		context: Context,
	): Promise<ReadonlyMap<string, ForwardedToolCalls>> {
		const maxTokens = request.maxOutputTokens ?? 10000;
		if (
			!Number.isSafeInteger(maxTokens) ||
			maxTokens < 1 ||
			maxTokens > MAX_CODE_MODE_OUTPUT_TOKENS
		)
			throw new TypeError("Invalid historical execution output budget");
		const requested = new Map(request.cellIds.map((id) => [taskId(id), id]));
		const results = new Map<string, ForwardedToolCalls>();
		if (requested.size === 0) return results;
		const conversation = await harness.conversation(
			request.conversationId,
			context,
		);
		if (conversation === undefined)
			throw new Error("Historical execution conversation is unavailable");
		const cells = await harness.commit(async (tx) => {
			const ancestors = new Set<ConversationId>();
			let current: ConversationId | undefined = request.conversationId;
			while (current !== undefined) {
				if (ancestors.has(current))
					throw new Error("Cyclic conversation ancestry");
				ancestors.add(current);
				current = (await tx.conversation(current))?.parent?.conversationId;
			}
			const cells = new Map<
				TaskId,
				{ cellId: string; conversationId: ConversationId }
			>();
			for (const [id, cellId] of requested) {
				const record = await tx.task(id);
				if (
					record?.kind === `howaboua.execution.cell.${mode}` &&
					ancestors.has(record.conversationId)
				)
					cells.set(id, { cellId, conversationId: record.conversationId });
			}
			return cells;
		}, context);
		if (cells.size === 0) return results;
		const tail = (
			await conversation.entries({ order: "descending" }, 1, undefined, context)
		).items[0];
		if (tail === undefined) return results;
		// Entry and task IDs share the Session's monotonic namespace; a cell's audit cannot predate admission.
		const minimum = Math.min(...cells.keys()) as EntryId;
		if (minimum > tail.id) return results;
		let cursor: Cursor | undefined;
		do {
			const page = await conversation.entries(
				{ minEntryId: minimum, maxEntryId: tail.id, order: "ascending" },
				100,
				cursor,
				context,
			);
			for (const entry of page.items) {
				if (!NestedResultEntry.is(entry)) continue;
				const data = entry.data;
				const id = data["taskId"];
				if (
					typeof id !== "number" ||
					!Number.isSafeInteger(id) ||
					id <= 0 ||
					entry.byTaskId !== id
				)
					continue;
				const record = await harness.getTask(id as TaskId, context);
				if (
					record?.kind !== `howaboua.execution.nested-tool.${mode}` ||
					record.owner === undefined ||
					record.state.status !== "terminal"
				)
					continue;
				const cell = cells.get(record.owner);
				if (
					cell === undefined ||
					record.conversationId !== cell.conversationId ||
					entry.conversationId !== cell.conversationId
				)
					continue;
				const input = object(record.input);
				const parent = object(input["parent"]);
				const callId = `nested-${id}`;
				if (
					parent["taskId"] !== record.owner ||
					typeof parent["callId"] !== "string" ||
					!parent["callId"] ||
					typeof input["name"] !== "string" ||
					!input["name"] ||
					data["name"] !== input["name"] ||
					data["callId"] !== callId
				)
					throw new TypeError(
						"Historical execution audit does not match its task admission",
					);
				const intent =
					data["intent"] === undefined ? undefined : object(data["intent"]);
				const args =
					intent === undefined ? data["arguments"] : intent["arguments"];
				if (args === undefined)
					throw new TypeError("Historical execution arguments are unavailable");
				const stored = object(data["result"]);
				const receipt = parseExecutionResultReceipt({
					content: stored["output"] ?? stored["content"] ?? [],
					isError: stored["isError"] ?? false,
					details: stored["details"] ?? null,
					diagnostics: stored["diagnostics"] ?? [],
				});
				if (receipt === null)
					throw new TypeError("Historical execution result is unavailable");
				const outcome = record.state.outcome;
				const call: ForwardedToolCall = {
					callId,
					parentCallId: parent["callId"],
					name: input["name"],
					arguments: args,
					status: forwardedStatus(
						{ diagnostics: receipt.diagnostics },
						outcome.status === "completed"
							? "completed"
							: outcome.status === "aborted"
								? "aborted"
								: "failed",
					),
					result: receipt,
					omittedFields: [],
				};
				const previous = results.get(cell.cellId) ?? {
					version: 1,
					cellId: cell.cellId,
					calls: [],
					omittedCalls: 0,
				};
				if (previous.calls.some((item) => item.callId === callId))
					throw new TypeError("Duplicate historical execution result");
				// Audits arrive in settlement order; task IDs retain actual admission order.
				const calls = [...previous.calls, call].sort(
					(left, right) =>
						Number(left.callId.slice("nested-".length)) -
						Number(right.callId.slice("nested-".length)),
				);
				results.set(
					cell.cellId,
					boundForwardedToolCalls({ ...previous, calls }, maxTokens * 4),
				);
			}
			cursor = page.next;
		} while (cursor !== undefined);
		return results;
	};
}
