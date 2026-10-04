import { type Context, copyJson } from "@earendil-works/chord";
import type { ToolCall, Usage } from "@earendil-works/pi-ai";
import {
	defineEntry,
	type JsonObject,
	type ToolExecutionResult,
	UsageDoc,
} from "@earendil-works/pi-durable";
import {
	executionError,
	InvocationDoc,
	storeResult,
	truncation,
} from "./invocation.ts";
import type { Runtime } from "./nested-call.ts";

/** An audit record, deliberately with no assistant or tool-result model contribution. */
const NestedResultEntry = defineEntry<JsonObject>(
	"howaboua.execution.nested-result",
);

export async function interrupted(
	runtime: Runtime,
	call: ToolCall,
	code: "interrupted" | "aborted",
	message: string,
	context: Context,
): Promise<void> {
	const state = await runtime.snapshot(InvocationDoc, runtime.taskId, context);
	const partial = state?.result ?? {};
	const diagnostics = [...(partial.diagnostics ?? [])];
	if ((state?.droppedBytes ?? 0) > 0)
		diagnostics.push(
			truncation({
				droppedBytes: state?.droppedBytes ?? 0,
				droppedLines: state?.droppedLines ?? 0,
			}),
		);
	await settle(
		runtime,
		call,
		{
			...partial,
			isError: true,
			diagnostics: [
				...diagnostics,
				...(executionError(code, message).diagnostics ?? []),
			],
		},
		code === "aborted" ? "aborted" : "failed",
		context,
	);
}

export async function settle(
	runtime: Runtime,
	call: ToolCall,
	result: ToolExecutionResult,
	ending: "completed" | "failed" | "aborted",
	context: Context,
): Promise<void> {
	const stored = storeResult(result);
	await runtime.commit(async (tx, current) => {
		(await tx.doc(InvocationDoc, runtime.taskId)).result = stored;
		await tx.appendEntry(NestedResultEntry, runtime.conversationId, {
			data: {
				taskId: runtime.taskId,
				callId: call.id,
				name: call.name,
				arguments: copyJson(call.arguments),
				result: stored,
				...(current.state.checkpoint.phase === "execute"
					? {
							intent: {
								arguments: copyJson(current.state.checkpoint.arguments),
								replay: current.state.checkpoint.replay,
							},
						}
					: {}),
			},
		});
		if (result.usage !== undefined) {
			const totals = (await tx.doc(UsageDoc, runtime.conversationId)).tools;
			const previous = Object.hasOwn(totals, call.name)
				? totals[call.name]
				: undefined;
			totals[call.name] = copyJson(
				previous === undefined
					? result.usage
					: sumUsage(previous, result.usage),
				{ omitUndefinedProperties: true },
			) as NonNullable<typeof previous>;
		}
		const outcome =
			ending === "completed"
				? { status: ending, result: stored }
				: ending === "aborted"
					? { status: ending, result: stored }
					: {
							status: ending,
							error: {
								message: `Tool ${call.name} ${result.diagnostics?.at(-1)?.code === "interrupted" ? "was interrupted" : "threw"}`,
							},
							result: stored,
						};
		return { status: "terminal", outcome };
	}, context);
}

function sumUsage(previous: Usage, added: Usage): Usage {
	return {
		input: previous.input + added.input,
		output: previous.output + added.output,
		cacheRead: previous.cacheRead + added.cacheRead,
		cacheWrite: previous.cacheWrite + added.cacheWrite,
		totalTokens: previous.totalTokens + added.totalTokens,
		...(previous.cacheWrite1h === undefined && added.cacheWrite1h === undefined
			? {}
			: {
					cacheWrite1h:
						(previous.cacheWrite1h ?? 0) + (added.cacheWrite1h ?? 0),
				}),
		...(previous.reasoning === undefined && added.reasoning === undefined
			? {}
			: { reasoning: (previous.reasoning ?? 0) + (added.reasoning ?? 0) }),
		cost: {
			input: previous.cost.input + added.cost.input,
			output: previous.cost.output + added.cost.output,
			cacheRead: previous.cost.cacheRead + added.cost.cacheRead,
			cacheWrite: previous.cost.cacheWrite + added.cost.cacheWrite,
			total: previous.cost.total + added.cost.total,
		},
	};
}
