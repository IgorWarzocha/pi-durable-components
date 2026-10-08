type JsonValue =
	| null
	| boolean
	| number
	| string
	| readonly JsonValue[]
	| { readonly [key: string]: JsonValue };

export type ExecutionCellStatus =
	| "running"
	| "completed"
	| "failed"
	| "aborted"
	| "interrupted";

export interface ExecutionCellReference {
	readonly id: string;
	readonly status: ExecutionCellStatus;
}

/** Display receipt only. Usage and tool controls remain owned by Durable. */
export interface ExecutionResultReceipt {
	readonly content: readonly (
		| { readonly type: "text"; readonly text: string }
		| {
				readonly type: "image";
				readonly data: string;
				readonly mimeType: string;
		  }
	)[];
	readonly isError: boolean;
	readonly details: JsonValue;
	readonly diagnostics: readonly {
		readonly severity: "info" | "warn" | "error";
		readonly message: string;
		readonly code?: string;
	}[];
}

/** Host-projected identity and independently acquired, bounded exec/wait or control receipt. */
export interface ExecutionPresentationState {
	readonly cell: ExecutionCellReference | null;
	readonly result: ExecutionResultReceipt | null;
}

export interface ExecutionSummaryModel {
	readonly title: string;
	readonly cell: ExecutionCellReference | null;
	readonly hasResult: boolean;
	readonly isError: boolean | null;
}

function object(value: JsonValue | undefined) {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		(Object.getPrototypeOf(value) !== Object.prototype &&
			Object.getPrototypeOf(value) !== null)
	)
		throw new TypeError("Expected execution presentation object");
	return value as { readonly [key: string]: JsonValue };
}

function string(value: JsonValue | undefined): string {
	if (typeof value !== "string") throw new TypeError("Expected string");
	return value;
}

function json(value: JsonValue, ancestors = new Set<object>()): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean")
		return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "object" || ancestors.has(value))
		throw new TypeError("Expected finite, acyclic JSON details");
	ancestors.add(value);
	try {
		if (!Array.isArray(value)) object(value);
		return Array.isArray(value)
			? value.map((item: JsonValue) => json(item, ancestors))
			: Object.fromEntries(
					Object.entries(value).map(([key, item]) => [
						key,
						json(item, ancestors),
					]),
				);
	} finally {
		ancestors.delete(value);
	}
}

function cell(value: JsonValue | undefined): ExecutionCellReference | null {
	if (value === null) return null;
	const fields = object(value);
	const id = string(fields["id"]);
	if (!/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id)))
		throw new TypeError("Invalid execution cell ID");
	const status = fields["status"];
	if (
		status !== "running" &&
		status !== "completed" &&
		status !== "failed" &&
		status !== "aborted" &&
		status !== "interrupted"
	)
		throw new TypeError("Invalid execution cell status");
	return { id, status };
}

function receipt(value: JsonValue | undefined): ExecutionResultReceipt | null {
	if (value === null) return null;
	const fields = object(value);
	const content = fields["content"] === undefined ? [] : fields["content"];
	const diagnostics =
		fields["diagnostics"] === undefined ? [] : fields["diagnostics"];
	const isError = fields["isError"] === undefined ? false : fields["isError"];
	if (
		!Array.isArray(content) ||
		!Array.isArray(diagnostics) ||
		typeof isError !== "boolean"
	)
		throw new TypeError("Invalid execution result receipt");
	return {
		content: content.map((value: JsonValue) => {
			const item = object(value);
			if (item["type"] === "text")
				return { type: "text" as const, text: string(item["text"]) };
			if (item["type"] === "image") {
				const mimeType = string(item["mimeType"]);
				const data = string(item["data"]);
				if (
					!/^image\/[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(mimeType) ||
					data.length % 4 !== 0 ||
					!/^[A-Za-z0-9+/]*={0,2}$/.test(data)
				)
					throw new TypeError("Invalid execution image");
				return { type: "image" as const, data, mimeType };
			}
			throw new TypeError("Invalid execution content type");
		}),
		isError,
		details: json(fields["details"] ?? null),
		diagnostics: diagnostics.map((value: JsonValue) => {
			const item = object(value);
			const severity = item["severity"];
			if (severity !== "info" && severity !== "warn" && severity !== "error")
				throw new TypeError("Invalid execution diagnostic severity");
			return {
				severity,
				message: string(item["message"]),
				...(item["code"] === undefined ? {} : { code: string(item["code"]) }),
			};
		}),
	};
}

/** No acquisition, invocation, cancellation, replay or runtime-status inference. */
function parseExecutionPresentationState(
	value: JsonValue,
): ExecutionPresentationState {
	const fields = object(value);
	return { cell: cell(fields["cell"]), result: receipt(fields["result"]) };
}

export function executionCapability(id: string, actions: readonly string[]) {
	return {
		id,
		version: 1,
		actions,
		streams: ["results"] as const,
		presentations: ["summary", "detail"] as const,
		parseState: parseExecutionPresentationState,
	};
}

export function executionSummary(title: string) {
	return {
		id: "summary",
		select: (state: ExecutionPresentationState): ExecutionSummaryModel => ({
			title,
			cell: state.cell,
			hasResult: state.result !== null,
			isError: state.result?.isError ?? null,
		}),
		requests: ["detail"] as const,
	};
}

export const executionDetail = {
	id: "detail",
	select: (state: ExecutionPresentationState): ExecutionPresentationState =>
		state,
	requests: [] as const,
};
