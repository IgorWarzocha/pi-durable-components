// Adapted from @howaboua/pi-codex-conversion, MIT. See ../NOTICE.
function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export type HostMessage =
	| { type: "connection/ready"; selectedVersion: 1; capabilities: string[] }
	| { type: "connection/rejected"; reason: unknown }
	| { type: "operation/response"; id: number; result: HostResult }
	| { type: "execute/initialResponse"; id: number; result: HostResult }
	| ({ type: "delegate/request" } & DelegateRequestMessage)
	| { type: "delegate/cancel"; id: number }
	| { type: "cell/closed"; cellId: string };

export interface DelegateRequestMessage {
	id: number;
	request:
		| { type: "notification/send"; cellId: string; text: string }
		| {
				type: "tool/invoke";
				invocation: {
					cell_id: string;
					input?: unknown;
					runtime_tool_call_id: string;
					tool_name: { name: string; namespace?: string | undefined };
				};
		  };
}

type HostResult =
	| { status: "ok"; value: unknown }
	| { status: "error"; message: string };

export function parseHostMessage(value: unknown): HostMessage {
	if (!isRecord(value) || typeof value["type"] !== "string")
		throw new Error("Code-mode host returned an invalid message");
	const type = value["type"];
	if (type === "connection/ready") {
		if (value["selectedVersion"] !== 1 || !isStringArray(value["capabilities"]))
			throw new Error("Code-mode host negotiated an invalid protocol");
		return { type, selectedVersion: 1, capabilities: value["capabilities"] };
	}
	if (type === "connection/rejected") return { type, reason: value["reason"] };
	if (type === "operation/response" || type === "execute/initialResponse")
		return {
			type,
			id: parseMessageId(value["id"]),
			result: parseHostResult(value["result"]),
		};
	if (type === "delegate/cancel")
		return { type, id: parseMessageId(value["id"]) };
	if (type === "cell/closed") {
		if (typeof value["cellId"] !== "string")
			throw new Error("Code-mode host returned an invalid cell closure");
		return { type, cellId: value["cellId"] };
	}
	if (type === "delegate/request")
		return { type, ...parseDelegateRequest(value) };
	throw new Error(`Code-mode host returned an unsupported message: ${type}`);
}

export function executionCellId(value: unknown): string | undefined {
	return isRecord(value) &&
		value["type"] === "execution/started" &&
		typeof value["cellId"] === "string"
		? value["cellId"]
		: undefined;
}

export function runtimeOutcome(value: unknown): unknown {
	if (!isRecord(value) || !isRecord(value["outcome"])) return undefined;
	return value["outcome"]["LiveCell"] ?? value["outcome"]["MissingCell"];
}

function parseDelegateRequest(
	value: Record<string, unknown>,
): DelegateRequestMessage {
	const id = parseMessageId(value["id"]);
	const request = value["request"];
	if (!isRecord(request) || typeof request["type"] !== "string")
		throw new Error("Code-mode host returned an invalid delegate request");
	if (request["type"] === "notification/send") {
		if (
			typeof request["cellId"] !== "string" ||
			typeof request["text"] !== "string"
		)
			throw new Error("Code-mode host returned an invalid notification");
		return {
			id,
			request: {
				type: "notification/send",
				cellId: request["cellId"],
				text: request["text"],
			},
		};
	}
	if (request["type"] !== "tool/invoke" || !isRecord(request["invocation"]))
		throw new Error("Code-mode host returned an invalid tool invocation");
	const invocation = request["invocation"];
	const toolName = invocation["tool_name"];
	const namespace = isRecord(toolName) ? toolName["namespace"] : undefined;
	if (
		typeof invocation["cell_id"] !== "string" ||
		typeof invocation["runtime_tool_call_id"] !== "string" ||
		!isRecord(toolName) ||
		typeof toolName["name"] !== "string" ||
		(namespace !== undefined &&
			namespace !== null &&
			typeof namespace !== "string")
	)
		throw new Error("Code-mode host returned an invalid tool invocation");
	return {
		id,
		request: {
			type: "tool/invoke",
			invocation: {
				cell_id: invocation["cell_id"],
				runtime_tool_call_id: invocation["runtime_tool_call_id"],
				tool_name: {
					name: toolName["name"],
					...(typeof namespace === "string" ? { namespace } : {}),
				},
				...(invocation["input"] === undefined
					? {}
					: { input: invocation["input"] }),
			},
		},
	};
}

function parseHostResult(value: unknown): HostResult {
	if (!isRecord(value))
		throw new Error("Code-mode host returned an invalid operation result");
	if (value["status"] === "ok") return { status: "ok", value: value["value"] };
	if (value["status"] === "error" && typeof value["message"] === "string")
		return { status: "error", message: value["message"] };
	throw new Error("Code-mode host returned an invalid operation result");
}

function parseMessageId(value: unknown): number {
	if (!Number.isSafeInteger(value) || Number(value) < 0)
		throw new Error("Code-mode host returned an invalid message id");
	return Number(value);
}

function isStringArray(value: unknown): value is string[] {
	return (
		Array.isArray(value) && value.every((entry) => typeof entry === "string")
	);
}
