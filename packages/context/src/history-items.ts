// Adapted from pi-codex-conversion, Copyright (c) 2026 Igor Warzocha, MIT.
import type { Message } from "@earendil-works/pi-ai";
import type { EntryRecord, JsonObject } from "@earendil-works/pi-durable";
import type { HistoryArguments } from "./tool-contract.ts";

export type HistoryItem = {
	window_id: string;
	item_id: string;
	role: string;
	tool_name?: string;
	tool_namespace?: string;
	content: string;
};

export function historyItem(
	entry: EntryRecord,
	windowId: string,
): HistoryItem | undefined {
	const first = entry.model?.[0];
	if (!first) return undefined;
	const tool = toolIdentity(first);
	return {
		window_id: windowId,
		item_id: String(entry.id),
		role: first.role === "toolResult" ? "tool" : first.role,
		...tool,
		content: (entry.model ?? []).map(renderMessage).join("\n"),
	};
}

function toolIdentity(message: Message): {
	tool_name?: string;
	tool_namespace?: string;
} {
	if (message.role === "toolResult") return { tool_name: message.toolName };
	if (message.role !== "assistant") return {};
	const call = message.content.find((block) => block.type === "toolCall");
	if (!call || call.type !== "toolCall") return {};
	return {
		tool_name: call.name,
		...(call.namespace ? { tool_namespace: call.namespace } : {}),
	};
}

function renderMessage(message: Message): string {
	// System sections and tool declarations are not in content, but are history too.
	if (message.role === "system") return JSON.stringify(withoutBinary(message));
	if (typeof message.content === "string") return message.content;
	return message.content
		.map((block) => {
			switch (block.type) {
				case "text":
					return block.text;
				case "thinking":
					return block.thinking;
				case "image":
					return `[image ${block.mimeType || "attachment"}]`;
				case "toolCall":
					return JSON.stringify({
						tool: block.name,
						arguments: withoutBinary(block.arguments),
					});
			}
		})
		.join("\n");
}

/** Tool arguments can contain nested image blocks. Never serialize their binary payloads. */
function withoutBinary(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutBinary);
	if (!value || typeof value !== "object") return value;
	const result: Record<string, unknown> = {};
	const fields = Object.entries(value);
	const image = fields.some(
		([key, item]) =>
			(key === "type" && item === "image") ||
			((key === "mimeType" || key === "mime_type") &&
				typeof item === "string" &&
				item.startsWith("image/")),
	);
	for (const [key, item] of fields) {
		if (
			(image && (key === "data" || key === "url")) ||
			/^(?:base64|b64_json|image_base64)$/i.test(key)
		) {
			result[key] = "[binary omitted]";
		} else if (typeof item === "string" && /^data:[^,]*;base64,/.test(item)) {
			result[key] = "[binary omitted]";
		} else result[key] = withoutBinary(item);
	}
	return result;
}

export function matchesHistoryItem(
	item: HistoryItem,
	args: HistoryArguments,
): boolean {
	return (
		(!args.window_id || item.window_id === args.window_id) &&
		(!args.role || item.role === args.role) &&
		(!args.tool_name || item.tool_name === args.tool_name) &&
		(!args.tool_namespace || item.tool_namespace === args.tool_namespace) &&
		(args.action !== "search_contents" ||
			item.content.includes(args.query ?? ""))
	);
}

export function itemIdentity(item: HistoryItem): JsonObject {
	return {
		window_id: item.window_id,
		item_id: item.item_id,
		role: item.role,
		...(item.tool_name ? { tool_name: item.tool_name } : {}),
		...(item.tool_namespace ? { tool_namespace: item.tool_namespace } : {}),
	};
}

export function previewHistoryItem(
	item: HistoryItem,
	maxChars: number,
): JsonObject {
	return {
		...itemIdentity(item),
		truncated_content: item.content.slice(0, maxChars),
		content_chars: item.content.length,
	};
}

export function boundedPreviews(items: readonly JsonObject[]): JsonObject[] {
	const result: JsonObject[] = [];
	let size = 0;
	for (const preview of items) {
		const previewSize = JSON.stringify(preview).length;
		if (result.length > 0 && size + previewSize > 8_000) break;
		result.push(preview);
		size += previewSize;
	}
	return result;
}
