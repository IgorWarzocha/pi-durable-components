// Adapted from pi-codex-conversion at b2006db9def12c373ae48e70044d30f7d6b7e34f, MIT. See ../NOTICE.
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { NotebookControlRequest } from "./runtime-contract.ts";

const NOTEBOOK_ACTION_PARAMETERS = Type.Union([
	Type.Object(
		{
			action: Type.Union([Type.Literal("status"), Type.Literal("list")]),
			query: Type.Optional(Type.String()),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Union([
				Type.Literal("checkpoint"),
				Type.Literal("restart"),
				Type.Literal("diagnostics"),
				Type.Literal("reset"),
			]),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Union([Type.Literal("save"), Type.Literal("load")]),
			name: Type.String(),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("pin"),
			names: Type.Array(Type.String(), { minItems: 1 }),
			hook: Type.Optional(
				Type.Union(
					[
						Type.Union([Type.Literal("startup"), Type.Literal("tool_result")]),
						Type.Literal(false),
					],
					{
						description:
							"Await self-contained fn(event); tool_result gets {type,toolName,input,status,result?,error?}; hook tool calls do not retrigger; false removes hook",
					},
				),
			),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Union([Type.Literal("unpin"), Type.Literal("release")]),
			names: Type.Array(Type.String(), { minItems: 1 }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("prune"),
			query: Type.String(),
		},
		{ additionalProperties: false },
	),
]);

export const NOTEBOOK_PARAMETERS = Type.Object(
	{
		input: Type.String({ description: "help or JSON action object" }),
	},
	{ additionalProperties: false },
);

export const NOTEBOOK_DESCRIPTION =
	"Control persistent notebook state; status queries memory/bindings by glob; prune removes unpinned matches; list/save/load manage profiles";

export const NOTEBOOK_HELP = `Call notebook with {"input":"help"} or {"input":"<JSON action object>"}.
Example: {"input":"{\\"action\\":\\"status\\",\\"query\\":\\"*\\"}"}
Action objects accept only the fields shown below; ? means optional.

{"action":"status","query"?:string}  Memory, checkpoint and retained-state summary; query inspects matching live bindings
{"action":"list","query"?:string}  List saved profiles, optionally filtered by name
{"action":"checkpoint"}  Persist current serializable state
{"action":"save","name":string}  Save current state as a named profile
{"action":"load","name":string}  Load a profile by value without replaying cells; release or rename colliding bindings first
{"action":"pin","names":string[],"hook"?:"startup"|"tool_result"|false}  Promote bindings to durable project state and protect from release/prune; omit hook to preserve it, false removes it
{"action":"unpin","names":string[]}  Remove pin protection and hooks, keeping bindings
{"action":"release","names":string[]}  Dispose and remove selected unpinned bindings; unpin protected bindings first
{"action":"prune","query":string}  Release unpinned bindings matching an explicit glob; pinned matches survive
{"action":"restart"}  Stop any active cell and restore the last completed checkpoint
{"action":"diagnostics"}  Check historical cells and runtime health without executing them
{"action":"reset"}  Stop any active cell and discard the session checkpoint; durable project state, saved notebook and named profiles survive

query uses case-insensitive * and ? globs. prune requires a nonempty query. names must be a nonempty array of binding-name strings. pin/release require existing JavaScript identifiers. Profile names: 1-64 letters, numbers, dots, underscores or hyphens, starting with a letter or number.

Hooks must be self-contained fn(event), awaited when invoked. startup gets {type:"startup"} once per fresh kernel after restoration, not when pinned; Tools cannot run during startup. tool_result gets {type:"tool_result",toolName,input,status:"success"|"error",result?,error?} after nested tool settlement; handlers are awaited in name order and their tool calls do not retrigger hooks. Recreate imports and live handles inside the function. Startup failures block execution; unpin remains available. External side effects are not rolled back.

Run management calls after exec returns. Inside exec, the existing tools.notebook({action,...}) supports status without query, list and diagnostics only. A blocked call returns the top-level retry. release/prune may restart the kernel for lexical bindings, clearing runtime-only handles. Inspect reported cleanup failures and restore notices. For failed state/helpers, diagnose, repair or prune, then verify recovery. restart restores completed state; reset discards only session state.`;

export function parseNotebookRequest(input: unknown): NotebookControlRequest {
	if (!Check(NOTEBOOK_ACTION_PARAMETERS, input))
		throw new Error(
			'Invalid notebook action arguments; call notebook with {"input":"help"}',
		);
	if (input.action === "prune" && !input.query.trim())
		throw new Error("notebook prune requires query");
	if (
		input.action === "pin" ||
		input.action === "unpin" ||
		input.action === "release"
	)
		return { ...input, names: [...new Set(input.names)] };
	return input;
}
