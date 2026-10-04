// Adapted from @howaboua/pi-codex-conversion, MIT. See ../NOTICE.
import type {
	RuntimeContentItem,
	RuntimeResponse,
} from "./runtime-contract.ts";
export function parseRuntimeResponse(value: unknown): RuntimeResponse {
	if (!isRecord(value))
		throw new Error("Code-mode host returned an invalid runtime response");
	const kind = isRecord(value["Yielded"])
		? "yielded"
		: isRecord(value["Terminated"])
			? "terminated"
			: isRecord(value["Result"])
				? "result"
				: undefined;
	if (!kind)
		throw new Error("Code-mode host returned an invalid runtime response");
	const body =
		value[
			kind === "yielded"
				? "Yielded"
				: kind === "terminated"
					? "Terminated"
					: "Result"
		];
	if (!isRecord(body) || typeof body["cell_id"] !== "string")
		throw new Error("Code-mode host returned an invalid runtime response");
	const contentItems = parseContentItems(body["content_items"]);
	return {
		kind,
		cellId: body["cell_id"],
		contentItems,
		...(kind === "result" && typeof body["error_text"] === "string"
			? { errorText: body["error_text"] }
			: {}),
	};
}

function parseContentItems(value: unknown): RuntimeContentItem[] {
	if (value === undefined) return [];
	if (!Array.isArray(value))
		throw new Error("Code-mode host returned invalid content items");
	return value.map((item) => {
		if (!isRecord(item))
			throw new Error("Code-mode host returned an invalid content item");
		if (item["type"] === "input_text" && typeof item["text"] === "string")
			return { type: "input_text", text: item["text"] };
		if (
			item["type"] === "input_image" &&
			typeof item["image_url"] === "string" &&
			isImageDetail(item["detail"])
		)
			return {
				type: "input_image",
				image_url: item["image_url"],
				...(item["detail"] === undefined ? {} : { detail: item["detail"] }),
			};
		if (item["type"] === "input_audio")
			throw new Error("Code-mode audio output is not supported by Pi");
		throw new Error("Code-mode host returned an invalid content item");
	});
}

function isImageDetail(
	value: unknown,
): value is "auto" | "low" | "high" | "original" | null | undefined {
	return (
		value === undefined ||
		value === null ||
		value === "auto" ||
		value === "low" ||
		value === "high" ||
		value === "original"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
