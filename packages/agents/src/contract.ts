import type { Static } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import type { AgentChange, JsonObject } from "@earendil-works/pi-durable";

export type AgentProfile = {
	description: string;
	agent: AgentChange;
	/** Overrides the call's blocking choice, as in the source profile policy. */
	blocking?: boolean;
};
export type AgentsOptions = {
	profiles: Readonly<Record<string, AgentProfile>>;
};

const target = Type.String({ minLength: 1 });
const message = Type.String({ minLength: 1 });
const action = <T extends string>(name: T) => ({ action: Type.Literal(name) });
const object = { additionalProperties: false };
export const AgentsParameters = Type.Union([
	Type.Object(action("help"), object),
	Type.Object(
		{ ...action("list"), offset: Type.Optional(Type.Integer({ minimum: 0 })) },
		object,
	),
	Type.Object(
		{
			...action("find"),
			query: Type.Optional(Type.String()),
			status: Type.Optional(
				Type.Union([Type.Literal("idle"), Type.Literal("working")]),
			),
			offset: Type.Optional(Type.Integer({ minimum: 0 })),
		},
		object,
	),
	Type.Object(
		{
			...action("spawn"),
			agent_type: target,
			label: target,
			message,
			name: Type.Optional(target),
			cwd: Type.Optional(target),
			blocking: Type.Optional(
				Type.Boolean({
					description:
						"False while continuing other work; completion arrives automatically",
				}),
			),
		},
		object,
	),
	Type.Object({ ...action("send"), target, message }, object),
	Type.Object(
		{
			...action("assign"),
			target,
			message,
			blocking: Type.Optional(Type.Boolean()),
		},
		object,
	),
	Type.Object(
		{
			...action("read"),
			target,
			source: Type.Optional(
				Type.Union([Type.Literal("latest"), Type.Literal("recent")]),
			),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
			before: Type.Optional(Type.Integer({ minimum: 1 })),
			entry: Type.Optional(Type.Integer({ minimum: 1 })),
			offset: Type.Optional(Type.Integer({ minimum: 0 })),
		},
		object,
	),
	Type.Object({ ...action("watch"), target }, object),
	Type.Object({ ...action("unwatch"), target }, object),
	Type.Object({ ...action("attach"), target }, object),
	Type.Object({ ...action("detach"), target }, object),
]);
export type Request = Static<typeof AgentsParameters>;
export type WorkRequest = Extract<Request, { action: "spawn" | "assign" }>;
export const response = (details: JsonObject, isError = false) => ({
	content: [{ type: "text" as const, text: JSON.stringify(details) }],
	details,
	isError,
});

export function help(profiles: AgentsOptions["profiles"]) {
	return response({
		actions: {
			help: "",
			list: "offset?",
			find: "query? status? offset?",
			spawn: "agent_type label message name? cwd? blocking?",
			send: "target message",
			assign: "target message blocking?",
			read: "target source? limit? before? entry? offset?",
			watch: "target",
			unwatch: "target",
			attach: "target",
			detach: "target",
		},
		profiles: Object.fromEntries(
			Object.entries(profiles).map(([name, profile]) => [
				name,
				{
					description: profile.description,
					...(profile.blocking === undefined
						? {}
						: { blocking: profile.blocking }),
				},
			]),
		),
		rules: {
			target:
				"Use the conversation ID from spawn/find, or an exact unique name",
			blocking:
				"Defaults true; spawn profile policy overrides. False reports completion after you reply. No polling",
			send: "Admits a message, wakes idle recipients, steers active work. No wait or implicit watch",
			watch: "Persists until unwatch; delegation reports are task-scoped",
			attach:
				"Joins an idle root agent to your discussion board. Detach restores its previous board. Targets must have no board children. No shared context or task assignment",
			read: "latest returns the newest assistant; recent returns a bounded transcript page. before continues older entries; entry + nextOffset retrieves truncated text",
		},
	});
}
