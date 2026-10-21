import { Type } from "@earendil-works/pi-ai";
import type {
	AgentChange,
	ConversationId,
	JsonObject,
	Tx,
} from "@earendil-works/pi-durable";
import type { Static } from "typebox";

export type AgentProfile = {
	description: string;
	agent: AgentChange;
	/** Overrides the call's blocking choice, as in the source profile policy. */
	blocking?: boolean;
};
export type AgentsOptions = {
	profiles: Readonly<Record<string, AgentProfile>>;
	/** Optional Board component; validates explicit thread handoffs in the spawn commit. */
	board?: {
		threadReference(
			tx: Tx,
			caller: ConversationId,
			threadId: string,
		): Promise<string>;
	};
};

const target = Type.String({ minLength: 1 });
const message = Type.String({ minLength: 1 });
const action = <T extends string>(name: T) => ({ action: Type.Literal(name) });
const object = { additionalProperties: false };
export const AgentsParameters = Type.Union([
	Type.Object({ action: Type.Optional(Type.Literal("help")) }, object),
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
			board_thread_id: Type.Optional(Type.String({ format: "uuid" })),
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
	Type.Object({ ...action("watch"), target }, object),
	Type.Object({ ...action("unwatch"), target }, object),
]);
export type Request = Static<typeof AgentsParameters>;
export type WorkRequest = Extract<Request, { action: "spawn" | "assign" }>;
export const response = (details: JsonObject, isError = false) => ({
	output: [{ type: "text" as const, text: JSON.stringify(details) }],
	details,
	isError,
});

export function help(profiles: AgentsOptions["profiles"]) {
	return response({
		actions: {
			help: "",
			list: "offset?",
			find: "query? status? offset?",
			spawn: "agent_type label message name? cwd? blocking? board_thread_id?",
			send: "target message",
			assign: "target message blocking?",
			watch: "target",
			unwatch: "target",
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
			label: "Short agent label; prefer two words when useful",
			prompt:
				"Give each worker a distinct scope, desired outcome, relevant project context and issue references. Describe success rather than lists of forbidden investigations",
			blocking:
				"Defaults true; spawn profile policy overrides. In JavaScript cells, use await Promise.allSettled for parallel calls that wait for every result, including failures. Use false only to continue other work; completion arrives after your reply. No polling or sleep waits",
			send: "Admits a message, wakes idle recipients, steers active work. No wait or implicit watch",
			watch: "Persists until unwatch; delegation reports are task-scoped",
			board_thread_id:
				"Requires the host's Board component. Validates a thread in your current board before spawning and adds its read reference to the task. Board membership and attach/detach belong to board",
		},
	});
}
