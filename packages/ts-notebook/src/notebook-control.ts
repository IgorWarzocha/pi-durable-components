// Adapted from pi-codex-conversion at b2006db9def12c373ae48e70044d30f7d6b7e34f, MIT. See ../NOTICE.
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { NotebookControlRequest } from "./runtime-contract.ts";

export const NOTEBOOK_ACTION_PARAMETERS = Type.Union([
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
			checkpoint: Type.Optional(
				Type.Object(
					{ snapshot: Type.String(), restore: Type.String() },
					{ additionalProperties: false },
				),
			),
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
		input: Type.Optional(
			Type.String({
				description:
					'help or JSON, e.g. {"action":"status"}; not a bare action name',
			}),
		),
	},
	{ additionalProperties: false },
);

export const NOTEBOOK_HELP = `Call notebook with {} for help or {"input":"<JSON action object>"}.
Actions: status {query?}, list {query?}, checkpoint, save {name}, load {name}, pin {names,hook?,checkpoint?}, unpin {names}, release {names}, prune {query}, restart, diagnostics, reset.
Normal cells retain live closures, classes and imported handles. Only portable values and named function recipes survive restart. Non-portable values remain live and are reported as skipped. A pin with checkpoint:{snapshot:"namedFunction",restore:"namedFunction"} opts a live binding into by-value restoration. Helpers must be portable named functions or imports; restoration runs them, never cell history.
Pins persist across sessions in the same project and survive prune. pin hook:"startup" awaits a function once per fresh kernel after restoration. pin hook:"tool_result" awaits a function after each settled tool with {type,toolName,input,status,result?,error?}; hook calls do not retrigger hooks. false removes the hook. Startup cannot invoke tools. Unpin removes hooks and checkpoint recipes.
Run lifecycle changes only after cells finish. Inside exec, tools.notebook({}) returns help; status without query, list and diagnostics are available. Save stores portable state. Profile load adds bindings and rejects collisions. Isolated cells fork committed state, never live-only values; list shows their candidate-* snapshots. Loading a candidate REPLACES live state and loses live-only values and changes since that candidate. Release and prune can restart the kernel and lose live-only handles. restart restores the last durable checkpoint. reset returns to project pins; named profiles survive.
Stopping a live cell invalidates the live kernel. Use restart; interrupted effects have uncertain outcomes and are never rolled back or replayed. Strict checking rejects the whole cell before its source starts.`;

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
