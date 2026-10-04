import type { Context } from "@earendil-works/chord";
import {
	defineDocFamily,
	type TaskId,
	type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import type { CellObservation } from "../../execution/src/cell-contract.ts";
import { boundOutput } from "../../execution/src/output.ts";

const ObservationCursor = defineDocFamily<{ items: number }, null>({
	kind: "howaboua.notebook.observation",
	version: 1,
	family: true,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ items: 0 }),
});

export function notebookCellTaskId(
	value: string,
): TaskId<import("@earendil-works/pi-durable").ToolExecutionResult> {
	const id = Number(value);
	if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(id))
		throw new Error("Invalid notebook cell_id");
	return id as TaskId<import("@earendil-works/pi-durable").ToolExecutionResult>;
}

export async function observeNotebookCell(
	observation: CellObservation,
	maxTokens: number,
	api: ToolExecutionApi,
	context: Context,
) {
	const result = observation.result;
	const allContent = result.content ?? [];
	const previous = await api.commit(async (tx) => {
		const cursor = await tx.doc(
			ObservationCursor,
			api.conversationId,
			String(observation.cellId),
			null,
		);
		const previous = cursor.items;
		cursor.items = allContent.length;
		return previous;
	}, context);
	const content = allContent.slice(previous);
	const text = content
		.filter((each) => each.type === "text")
		.map((each) => each.text)
		.join("\n");
	const bounded = boundOutput(text, {
		maxBytes: maxTokens * 4,
		maxLines: Number.MAX_SAFE_INTEGER,
		retain: "head",
	});
	const marker =
		observation.status === "running"
			? `Still running (exec cell "${observation.cellId}"). Use wait near expected completion`
			: observation.status === "aborted"
				? "Script terminated; external side effects were not rolled back"
				: undefined;
	const emitted = [
		...(marker ? [{ type: "text" as const, text: marker }] : []),
		...(bounded.text ? [{ type: "text" as const, text: bounded.text }] : []),
		...content.filter((each) => each.type !== "text"),
	];
	if (emitted.length === 0) emitted.push({ type: "text", text: "OK" });
	return {
		...result,
		content: emitted,
		details: {
			cell_id: String(observation.cellId),
			status: observation.status,
			...(result.details === undefined ? {} : { runtime: result.details }),
		},
		...(bounded.droppedBytes
			? {
					diagnostics: [
						...(result.diagnostics ?? []),
						{
							severity: "warn" as const,
							code: "truncated",
							message: `${bounded.droppedBytes} bytes omitted by max_tokens`,
						},
					],
				}
			: {}),
	};
}
