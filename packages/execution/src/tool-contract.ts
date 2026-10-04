import { copyJson, type JsonValue } from "@earendil-works/chord";
import type { TSchema } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";

/** Optional runtime presentation and observation policy on an ordinary registration. */
interface ExecutionToolHints {
	readonly usage?: string;
	readonly output?: string;
	readonly deferLoading?: boolean;
	readonly yieldTimeMs?: number;
	readonly inputSchema?: JsonValue;
}

export type ExecutionToolRegistration<
	T extends TSchema = TSchema,
	D extends JsonValue = JsonValue,
> = ToolRegistration<T, D> & {
	readonly executionHints?: ExecutionToolHints;
};

interface ExecutionToolContract {
	readonly name: string;
	readonly description: string;
	readonly usage: string;
	readonly output?: string;
	readonly inputSchema: JsonValue;
	readonly deferLoading: boolean;
	readonly yieldTimeMs?: number;
	readonly help: string;
}

/** Metadata does not change implementation parameters, repair, validation or dispatch. */
export function readToolContract(
	tool: ToolRegistration | ExecutionToolRegistration,
): ExecutionToolContract {
	const candidate = "executionHints" in tool ? tool.executionHints : undefined;
	if (
		candidate !== undefined &&
		(candidate === null ||
			typeof candidate !== "object" ||
			Array.isArray(candidate))
	) {
		throw new Error(`Tool ${tool.name} executionHints must be an object`);
	}
	const hints = candidate ?? {};
	const supported = new Set([
		"usage",
		"output",
		"deferLoading",
		"yieldTimeMs",
		"inputSchema",
	]);
	for (const key of Object.keys(hints))
		if (!supported.has(key))
			throw new Error(
				`Tool ${tool.name} executionHints has unsupported field ${key}`,
			);
	const usageHint = "usage" in hints ? hints.usage : undefined;
	const output = "output" in hints ? hints.output : undefined;
	for (const [field, value] of [
		["usage", usageHint],
		["output", output],
	]) {
		if (value !== undefined && (typeof value !== "string" || !value.trim()))
			throw new Error(
				`Tool ${tool.name} executionHints.${field} must be a non-empty string`,
			);
	}
	const deferred = "deferLoading" in hints ? hints.deferLoading : undefined;
	if (deferred !== undefined && typeof deferred !== "boolean")
		throw new Error(
			`Tool ${tool.name} executionHints.deferLoading must be a boolean`,
		);
	const yieldTimeMs = "yieldTimeMs" in hints ? hints.yieldTimeMs : undefined;
	if (
		yieldTimeMs !== undefined &&
		(typeof yieldTimeMs !== "number" ||
			!Number.isSafeInteger(yieldTimeMs) ||
			yieldTimeMs < 0)
	)
		throw new Error(
			`Tool ${tool.name} executionHints.yieldTimeMs must be a non-negative safe integer`,
		);
	// Typebox carries non-enumerable runtime markers. Match the provider's JSON schema serialization.
	const inputSchema =
		"inputSchema" in hints && hints.inputSchema !== undefined
			? copyJson(hints.inputSchema)
			: copyJson(JSON.parse(JSON.stringify(tool.parameters)));
	const reference = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(tool.name)
		? `tools.${tool.name}`
		: `tools[${JSON.stringify(tool.name)}]`;
	const usage =
		typeof usageHint === "string" ? usageHint : `await ${reference}(args)`;
	const outputHint = typeof output === "string" ? output : undefined;
	return {
		name: tool.name,
		description: tool.description,
		usage,
		inputSchema,
		deferLoading: typeof deferred === "boolean" ? deferred : true,
		...(typeof yieldTimeMs === "number" ? { yieldTimeMs } : {}),
		...(outputHint === undefined ? {} : { output: outputHint }),
		help: [
			`Usage: ${usage}`,
			tool.description,
			`Schema: ${JSON.stringify(inputSchema)}`,
			...(outputHint === undefined ? [] : [`Output: ${outputHint}`]),
		]
			.filter(Boolean)
			.join("\n"),
	};
}
