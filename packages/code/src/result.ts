import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import type { RuntimeResponse } from "./runtime-contract.ts";

/** The source bridge bounds text at four characters per requested token and images independently. */
export function runtimeResult(
	response: RuntimeResponse,
	maxTokens = 10_000,
): ToolExecutionResult {
	const content: (TextContent | ImageContent)[] = [];
	let chars = Math.max(1, Math.min(100_000, maxTokens)) * 4;
	let imageChars = 0;
	let images = 0;
	let omitted = 0;
	let truncated = false;
	for (const item of response.contentItems) {
		if (item.type === "input_text") {
			if (item.text.length > chars) {
				if (!truncated)
					content.push({
						type: "text",
						text: `${item.text.slice(0, chars)}\n[Output truncated]`,
					});
				truncated = true;
				chars = 0;
			} else {
				content.push({ type: "text", text: item.text });
				chars -= item.text.length;
			}
		} else {
			const match = /^data:([^;,]+);base64,(.+)$/s.exec(item.image_url);
			if (!match?.[1] || !match[2])
				throw new Error("Code host image must be a base64 data URL");
			if (images >= 4 || imageChars + match[2].length > 16 * 1024 * 1024) {
				omitted++;
				continue;
			}
			images++;
			imageChars += match[2].length;
			content.push({ type: "image", mimeType: match[1], data: match[2] });
		}
	}
	if (omitted)
		content.push({
			type: "text",
			text: `[${omitted} code-mode images omitted]`,
		});
	if (response.errorText)
		content.unshift({
			type: "text",
			text: `Script error: ${response.errorText}`,
		});
	if (response.kind === "terminated")
		content.unshift({ type: "text", text: "Script terminated" });
	return {
		content,
		...(response.errorText ? { isError: true } : {}),
		details: {
			codeMode: true,
			runtimeCellId: response.cellId,
			status: response.kind,
			...(response.errorText ? { scriptError: response.errorText } : {}),
		},
	};
}
