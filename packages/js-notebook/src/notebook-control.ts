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
			action: Type.Literal("save"),
			name: Type.String(),
			names: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{ action: Type.Literal("load"), name: Type.String() },
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("hook"),
			name: Type.String(),
			event: Type.Union([
				Type.Literal("startup"),
				Type.Literal("tool_result"),
				Type.Literal(false),
			]),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("pin"),
			names: Type.Array(Type.String(), { minItems: 1 }),
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

export const NOTEBOOK_HELP = `Call notebook with {} or {"input":"help"}, or put a JSON action object in input.
{"action":"status","query"?:string}  Inspect binding inventory by glob
{"action":"diagnostics"}  Runtime and saved-state summary
{"action":"list","query"?:string}  List profiles and isolated candidates
{"action":"checkpoint"}  Save the complete VM without replay
{"action":"save","name":string,"names"?:string[]}  Save the whole VM, or selected plain data
{"action":"load","name":string}  Whole-VM profiles replace live state. Selected-data profiles add noncolliding bindings
{"action":"pin","names":string[]}  Persist plain data across project reset and protect its names
{"action":"unpin","names":string[]}  Remove protection, keeping live values
{"action":"hook","name":string,"event":"startup"|"tool_result"|false}  Register a retained function or remove its hook
{"action":"release","names":string[]}  Release unpinned bindings. Other aliases and closures remain
{"action":"prune","query":string}  Release matching unpinned bindings
{"action":"restart"}  Stop active cells and restore the last checkpoint
{"action":"reset"}  Discard the project VM. Pins and profiles survive

Run management after exec returns. Profile names: 1-64 letters, numbers, dots, underscores or hyphens, starting with a letter or number. Queries accept case-insensitive * and ? globs.
Normal cells share one serial project VM. isolated:true forks the last committed checkpoint and saves a candidate without changing live state. Loading a stale candidate is rejected and saves a recovery profile for deliberate replacement. Whole-VM snapshots preserve closures, classes and cycles. Selected data and reset-survival pins do not preserve functions or class instances.
Hooks are retained functions awaited in name order. startup receives {type:"startup"} once after restore and cannot call tools. tool_result receives {type:"tool_result",toolName,input,status,result?,error?}. Calls inside hooks do not retrigger hooks. Failed startup blocks normal execution. Cancellation stops the owned VM and restores only the last checkpoint on restart. Tool and file effects are never rolled back or replayed.`;

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
