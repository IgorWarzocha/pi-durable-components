import { copyJson, type JsonValue } from "@earendil-works/chord";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import type { CellObservation } from "../../execution/src/cell-contract.ts";
import { TRUNCATED_OUTPUT_NOTICE } from "../../execution/src/exec-source.ts";

export function guestContent(
	kind: "text" | "image",
	value: JsonValue,
): NonNullable<ToolExecutionResult["output"]>[number] {
	if (kind === "text")
		return {
			type: "text",
			text: typeof value === "string" ? value : JSON.stringify(value),
		};
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		typeof value["data"] !== "string" ||
		typeof value["mimeType"] !== "string" ||
		!/^image\/(png|jpeg|webp|gif)$/.test(value["mimeType"]) ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
			value["data"],
		)
	)
		throw new Error(
			"image requires {data: base64, mimeType: image/png|jpeg|webp|gif}",
		);
	return { type: "image", data: value["data"], mimeType: value["mimeType"] };
}

/** Bound each observation separately, without repeating the same running revision. */
export function observeWorkerCell(
	observation: CellObservation,
	maxTokens: number,
	delivered: Map<number, number>,
): ToolExecutionResult {
	const details = observation.result.details;
	const fields =
		details !== null && typeof details === "object" && !Array.isArray(details)
			? details
			: {};
	const revision = fields["revision"];
	const fresh =
		typeof revision !== "number" ||
		delivered.get(observation.cellId) !== revision;
	if (typeof revision === "number" && observation.status === "running")
		delivered.set(observation.cellId, revision);
	if (observation.status !== "running") delivered.delete(observation.cellId);
	let remaining = maxTokens * 4;
	const content: NonNullable<ToolExecutionResult["output"]> = [];
	let truncated = false;
	for (const item of fresh || observation.status !== "running"
		? (observation.result.output ?? [])
		: []) {
		const cost = item.type === "text" ? item.text.length : item.data.length;
		if (cost <= remaining) {
			content.push(item);
			remaining -= cost;
		} else {
			if (item.type === "text" && remaining > 0)
				content.push({ ...item, text: item.text.slice(0, remaining) });
			truncated = true;
			remaining = 0;
		}
	}
	if (truncated)
		content.push({
			type: "text",
			text: TRUNCATED_OUTPUT_NOTICE,
		});
	if (observation.status === "running")
		content.unshift({
			type: "text",
			text: `Still running (exec cell "${observation.cellId}"). Use wait to observe or terminate it`,
		});
	return {
		...observation.result,
		output: content,
		details: {
			...fields,
			cellId: observation.cellId,
			...(observation.forwardedToolCalls === undefined
				? {}
				: {
						forwardedToolCalls: copyJson(observation.forwardedToolCalls, {
							omitUndefinedProperties: true,
						}),
					}),
			status: observation.status,
		},
	};
}
