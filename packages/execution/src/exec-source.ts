// Adapted from @howaboua/pi-codex-conversion at b2006db9def12c373ae48e70044d30f7d6b7e34f, MIT. See ../NOTICE.
export const MAX_CODE_MODE_OUTPUT_TOKENS = 100_000;
export const DEFAULT_CODE_MODE_EXEC_YIELD_MS = 30_000;

/** Grow top-level wait observations after incomplete receipts. Requested waits remain a floor. */
export function adaptiveWaitMs(
	requestedMs: number,
	previousIncompleteWaits: number,
): number {
	const multiplier = 2 ** previousIncompleteWaits;
	const adaptive = Math.min(
		1_800_000,
		Math.max(5000 * multiplier, requestedMs * multiplier * 2),
	);
	return Math.max(requestedMs, adaptive);
}

export const CODE_MODE_EXEC_GRAMMAR = String.raw`
start: pragma_source | plain_source
pragma_source: PRAGMA_LINE NEWLINE SOURCE
plain_source: SOURCE

PRAGMA_LINE: /[ \t]*\/\/ @exec:[^\r\n]*/
NEWLINE: /\r?\n/
SOURCE: /[\s\S]+/
`;

export const CODE_MODE_EXEC_CONSTRAINED_SAMPLING = {
	type: "grammar",
	variants: { openai_lark: CODE_MODE_EXEC_GRAMMAR },
} as const;

/** A source cell with optional leading execution budget. Both drivers share this boundary. */
export function parseExecSource(source: string): {
	code: string;
	yieldTimeMs: number | null;
	maxOutputTokens: number | null;
} {
	if (!source.trim())
		throw new Error("exec requires non-empty JavaScript source");
	const [first, ...rest] = source.split("\n");
	const trimmed = first?.trimStart() ?? "";
	if (!trimmed.startsWith("// @exec:"))
		return { code: source, yieldTimeMs: null, maxOutputTokens: null };
	if (rest.join("\n").trim() === "")
		throw new Error("exec pragma must be followed by JavaScript source");
	const options: unknown = JSON.parse(trimmed.slice("// @exec:".length).trim());
	if (options === null || typeof options !== "object" || Array.isArray(options))
		throw new Error("exec pragma must be a JSON object");
	for (const key of Object.keys(options))
		if (key !== "yield_time_ms" && key !== "max_output_tokens")
			throw new Error(`Unsupported exec pragma field: ${key}`);
	return {
		code: rest.join("\n"),
		yieldTimeMs: parseInteger(
			"yield_time_ms" in options ? options.yield_time_ms : undefined,
			"yield_time_ms",
		),
		maxOutputTokens: parseInteger(
			"max_output_tokens" in options ? options.max_output_tokens : undefined,
			"max_output_tokens",
			1,
			MAX_CODE_MODE_OUTPUT_TOKENS,
		),
	};
}

function parseInteger(
	value: unknown,
	name: string,
	minimum = 0,
	maximum = Number.MAX_SAFE_INTEGER,
): number | null {
	if (value === undefined) return null;
	if (
		!Number.isSafeInteger(value) ||
		Number(value) < minimum ||
		Number(value) > maximum
	)
		throw new Error(
			`${name} must be a safe integer from ${minimum} to ${maximum}`,
		);
	return Number(value);
}
