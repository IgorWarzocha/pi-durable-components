import {
	type Context,
	copyJson,
	type JsonRepresentation,
	type JsonValue,
} from "@earendil-works/chord";
import { awaitWithContext } from "@earendil-works/chord/context";
import type { TextContent } from "@earendil-works/pi-ai";
import {
	defineDoc,
	type TaskRuntime,
	type ToolDiagnostic,
	type ToolExecutionApi,
	type ToolExecutionResult,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import {
	boundOutput,
	OutputBuffer,
	type OutputLimits,
	Progress,
} from "./output.ts";

type StoredResult = JsonRepresentation<ToolExecutionResult>;
export type InvocationState = {
	result: StoredResult;
	checkpoint?: JsonValue;
	yieldCount?: number;
	droppedBytes?: number;
	droppedLines?: number;
};
export const InvocationDoc = defineDoc<InvocationState>({
	kind: "howaboua.execution.invocation",
	version: 1,
	scope: "task",
	initial: () => ({ result: {} }),
});

export function storeResult(result: ToolExecutionResult): StoredResult {
	return copyJson(result, { omitUndefinedProperties: true }) as StoredResult;
}

export function executionError(
	code: string,
	message: string,
): ToolExecutionResult {
	return {
		content: [],
		isError: true,
		diagnostics: [{ severity: "error", code, message }],
	};
}

export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** One invocation owns its output, progress commits, environment and child-task API. */
export function createInvocation<I, S, R, H extends object>(
	runtime: TaskRuntime<I, S, R, H>,
	tool: Pick<ToolRegistration, "outputLimits">,
	context: Context,
) {
	const limits: OutputLimits = {
		maxBytes: tool.outputLimits?.maxBytes ?? 50 * 1024,
		maxLines: tool.outputLimits?.maxLines ?? 2000,
		retain: tool.outputLimits?.retain ?? "head",
	};
	const output = new OutputBuffer(limits);
	const diagnostics: ToolDiagnostic[] = [];
	let details: JsonValue | undefined;
	let ended = false;
	const assertLive = () => {
		if (ended) throw new Error(`Invocation ${runtime.taskId} has settled`);
	};
	const snapshot = (): ToolExecutionResult => {
		const retained = output.snapshot();
		return {
			content:
				retained.text === "" ? [] : [{ type: "text", text: retained.text }],
			...(details === undefined ? {} : { details }),
			diagnostics: [...diagnostics],
		};
	};
	const progress = new Progress(
		async () => {
			const result = storeResult(snapshot());
			const retained = output.snapshot();
			await runtime.commit(async (tx) => {
				const doc = await tx.doc(InvocationDoc, runtime.taskId);
				doc.result = result;
				doc.droppedBytes = retained.droppedBytes;
				doc.droppedLines = retained.droppedLines;
				return undefined;
			}, context);
			return JSON.stringify(result).length;
		},
		(error) => {
			if (!runtime.signal.aborted) runtime.report(error);
		},
	);
	const api: ToolExecutionApi = {
		taskId: runtime.taskId,
		conversationId: runtime.conversationId,
		callId: `nested-${runtime.taskId}`,
		registry: runtime.registry,
		agent: runtime.agent,
		env: undefined,
		output: (chunk) => {
			assertLive();
			if (output.push(chunk)) progress.mark();
		},
		diagnostic: (value) => {
			assertLive();
			diagnostics.push(
				copyJson(value, { omitUndefinedProperties: true }) as ToolDiagnostic,
			);
			progress.mark();
		},
		details: async (value, detailContext) => {
			assertLive();
			detailContext.abortSignal?.throwIfAborted();
			details = copyJson(value, { omitUndefinedProperties: true });
			const committed = progress.markAndWait();
			committed.catch(() => {});
			await awaitWithContext(committed, detailContext);
		},
		commit: async (change, commitContext) => {
			assertLive();
			let result: Awaited<ReturnType<typeof change>> | undefined;
			await runtime.commit(async (tx) => {
				result = await change(tx);
				return undefined;
			}, commitContext);
			return result as Awaited<ReturnType<typeof change>>;
		},
		memo: runtime.memo,
		createTask: async (task, input, options, taskContext) => {
			assertLive();
			let id;
			await runtime.commit(async (tx) => {
				id = await tx.createTask(task, input, options);
				return undefined;
			}, taskContext);
			if (id === undefined) throw new Error("Task creation did not commit");
			return id;
		},
		getTask: runtime.getTask,
		waitForTask: runtime.waitForTask,
		conversation: runtime.conversation,
		snapshot: runtime.snapshot,
		snapshotAsOf: runtime.snapshotAsOf,
		watchDoc: runtime.watchDoc,
	};
	return {
		/** Resolve the environment after the tracker exists, so environment failures still settle bounded hook results. */
		async executionApi(): Promise<ToolExecutionApi> {
			return { ...api, env: await runtime.env(context) };
		},
		async finish(result: ToolExecutionResult) {
			ended = true;
			output.end();
			const pending = await progress.stop();
			const retained = output.snapshot();
			const content =
				result.content ??
				(retained.text === ""
					? []
					: [{ type: "text" as const, text: retained.text }]);
			const final: ToolExecutionResult = {
				...result,
				content,
				...(result.details === undefined && details !== undefined
					? { details }
					: {}),
				diagnostics: [...diagnostics, ...(result.diagnostics ?? [])],
			};
			return { result: final, pending, retained, content };
		},
		async stop(error: unknown): Promise<void> {
			ended = true;
			for (const waiter of await progress.stop()) waiter.reject(error);
		},
		limits,
		output,
		progress,
	};
}

export function boundResult(
	result: ToolExecutionResult,
	limits: OutputLimits,
): ToolExecutionResult {
	const content = result.content ?? [];
	const texts = content.filter(
		(item): item is TextContent => item.type === "text",
	);
	const bounded = boundOutput(texts.map((item) => item.text).join(""), limits);
	if (bounded.droppedBytes === 0) return result;
	const keep = limits.retain === "head" ? texts[0] : texts.at(-1);
	return {
		...result,
		content: content.flatMap<
			TextContent | Extract<(typeof content)[number], { type: "image" }>
		>((item) =>
			item.type !== "text"
				? [item]
				: item === keep
					? [{ ...item, text: bounded.text }]
					: [],
		),
		diagnostics: [
			...(result.diagnostics ?? []),
			truncation(bounded, limits.retain),
		],
	};
}

export function truncation(
	dropped: { droppedLines: number; droppedBytes: number },
	retain?: "head" | "tail",
): ToolDiagnostic {
	const kept =
		retain === undefined
			? ""
			: ` to its ${retain === "head" ? "beginning" : "end"}`;
	return {
		severity: "warn",
		code: "truncated",
		message: `Output truncated${kept}: ${dropped.droppedLines} lines, ${dropped.droppedBytes} bytes dropped`,
	};
}
