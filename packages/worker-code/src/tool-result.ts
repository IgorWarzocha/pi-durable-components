import type { JsonValue } from "@earendil-works/chord";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { Check } from "typebox/value";

const number = Type.Number({ minimum: 0 });
const resultSchema = Type.Object(
	{
		content: Type.Optional(
			Type.Array(
				Type.Union([
					Type.Object({ type: Type.Literal("text"), text: Type.String() }),
					Type.Object({
						type: Type.Literal("image"),
						data: Type.String(),
						mimeType: Type.String(),
					}),
				]),
			),
		),
		isError: Type.Optional(Type.Boolean()),
		details: Type.Optional(Type.Unknown()),
		diagnostics: Type.Optional(
			Type.Array(
				Type.Object({
					severity: Type.Union([
						Type.Literal("info"),
						Type.Literal("warn"),
						Type.Literal("error"),
					]),
					message: Type.String(),
					code: Type.Optional(Type.String()),
				}),
			),
		),
		usage: Type.Optional(
			Type.Object(
				{
					input: number,
					output: number,
					cacheRead: number,
					cacheWrite: number,
					cacheWrite1h: Type.Optional(number),
					reasoning: Type.Optional(number),
					totalTokens: number,
					cost: Type.Object(
						{
							input: number,
							output: number,
							cacheRead: number,
							cacheWrite: number,
							total: number,
						},
						{ additionalProperties: false },
					),
				},
				{ additionalProperties: false },
			),
		),
		control: Type.Optional(
			Type.Object({
				addTools: Type.Optional(Type.Array(Type.String())),
				terminate: Type.Optional(Type.Literal(true)),
				handoff: Type.Optional(Type.String()),
			}),
		),
	},
	{ additionalProperties: false },
);

export function guestToolResult(value: JsonValue): ToolExecutionResult {
	if (!Check(resultSchema, value))
		throw new Error(
			"Guest handler must return a valid ToolExecutionResult JSON object",
		);
	return value as ToolExecutionResult;
}
