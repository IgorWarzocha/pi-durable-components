import type { ToolExecutionResult } from "@earendil-works/pi-durable";

class NestedToolError extends Error {
	readonly result: ToolExecutionResult;
	constructor(result: ToolExecutionResult, text: string) {
		super(
			result.diagnostics
				?.filter((item) => item.severity === "error")
				.map((item) => item.message)
				.join("\n") ||
				text ||
				"Tool failed",
		);
		this.name = "NestedToolError";
		this.result = result;
	}
}

/** One JS value projection for every ordinary registration. Images remain usable with image(). */
export function toolValue(result: ToolExecutionResult): unknown {
	const texts = (result.content ?? [])
		.filter((item) => item.type === "text")
		.map((item) => item.text);
	if (result.isError) throw new NestedToolError(result, texts.join("\n"));
	const images = (result.content ?? [])
		.filter((item) => item.type === "image")
		.map((item) => ({
			image_url: `data:${item.mimeType};base64,${item.data}`,
		}));
	let value: unknown = result.details;
	const objectDetails =
		value !== null && typeof value === "object" && !Array.isArray(value)
			? value
			: undefined;
	if (
		value === undefined ||
		(objectDetails !== undefined && Object.keys(objectDetails).length === 0)
	) {
		const text = texts.join("\n");
		try {
			value = JSON.parse(text) as unknown;
		} catch {
			value = text;
		}
	} else if (objectDetails !== undefined && (result.content?.length ?? 0) > 0) {
		// Ordinary tools often put displayable instructions/results in content and metadata in details.
		// Preserve details' own fields, including a field already named content.
		value = {
			...objectDetails,
			[Object.hasOwn(objectDetails, "content")
				? "toolResultContent"
				: "content"]: result.content,
		};
	} else if (
		(result.content?.length ?? 0) > 0 &&
		!(
			typeof value === "string" &&
			images.length === 0 &&
			texts.join("\n") === value
		)
	) {
		value = { value, content: result.content };
	}
	if (images.length)
		return {
			...(value !== null && typeof value === "object" && !Array.isArray(value)
				? value
				: { value }),
			...images[0],
			...(images.length > 1 ? { images } : {}),
		};
	return value;
}
