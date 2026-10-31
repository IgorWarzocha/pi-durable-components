import type { Context } from "@earendil-works/chord";
import type {
	ConversationId,
	SettledSubmissionRecord,
	TaskId,
	ToolExecutionApi,
	Tx,
} from "@earendil-works/pi-durable";
import { defineCapability, isCapabilityObject } from "./capabilities.ts";

export type ScheduledTiming =
	| { kind: "manual" }
	| { kind: "interval"; everyMs: number }
	| { kind: "daily"; hour: number; minute: number }
	| { kind: "weekly"; day: number; hour: number; minute: number }
	| { kind: "at"; atMs: number };

export type ScheduledQuietHours = { startMinute: number; endMinute: number };
export type SchedulingBinding = {
	key: string;
	root: string;
	parentConversationId?: ConversationId;
};
export type ScheduledSource = { id: string; text: string; error?: string };
export type ScheduledWork = {
	id: string;
	bindingKey: string;
	root: string;
	home: string;
	path: string;
	title: string;
	body: string;
	scheduleText: string;
	schedule: ScheduledTiming;
	enabled: boolean;
	target?: "child" | "resident";
	expiresAt?: number;
	quietHours?: ScheduledQuietHours;
};
export type ScheduledTrigger = "manual" | "scheduled";
export type ScheduledOccurrence = {
	count: number;
	startAt: number;
	endAt: number;
};
export type ScheduledRequest = {
	bindingKey: string;
	workId: string;
	requestId: string;
};
export type ScheduledAdmission = {
	binding: SchedulingBinding;
	work: ScheduledWork;
	trigger: ScheduledTrigger;
	requestId: string;
	taskId: TaskId;
	conversationId: ConversationId;
	occurrence?: ScheduledOccurrence;
};
export type ScheduledAdmissionDecision =
	| { status: "accepted" }
	| { status: "blocked"; reason: string; retryAt?: number };
export type ScheduledInput = {
	conversationId: ConversationId;
	taskId: TaskId;
	requestId: string;
	content: string;
};
export type ScheduledResult = {
	parentConversationId: ConversationId;
	conversationId: ConversationId;
	taskId: TaskId;
	outcome: SettledSubmissionRecord | { status: "aborted" };
	requestId: string;
	title: string;
	text: string;
	occurrence?: ScheduledOccurrence;
};

/** Workspace discovery and scheduling authority, shared by scheduled-work components. */
export interface SchedulingGrant {
	bindings(context: Context): Promise<readonly SchedulingBinding[]>;
	/** Read only immediate child definitions, within this binding's authorised execution environment. */
	readDefinitions(
		binding: SchedulingBinding,
		layout: { directory: string; fileName: string },
		context: Context,
	): Promise<readonly ScheduledSource[]>;
	/** Explicit policy/preparation for new work; never inferred from paths or request IDs. */
	authorize(
		binding: SchedulingBinding,
		work: ScheduledWork,
		trigger: ScheduledTrigger,
		context: Context,
	): Promise<void>;
	/** Document operations only, after native child creation. Preserve inherited model/tools/extensions. */
	configure(
		tx: Tx,
		conversationId: ConversationId,
		binding: SchedulingBinding,
		work: ScheduledWork,
		creation: { created: boolean },
	): Promise<void>;
	onError(error: unknown): void;
	/** Exact caller binding, resolved in api.env; absence disables model-initiated schedule actions. */
	resolveToolBinding?(api: ToolExecutionApi, context: Context): Promise<string>;
	/** Scope only; at most one run call. Admission policy remains in authorize/authorizeTransaction. */
	withToolRunAuthorization?(
		api: ToolExecutionApi,
		request: ScheduledRequest,
		run: () => Promise<TaskId | undefined>,
		context: Context,
	): Promise<TaskId | undefined>;
	/** Same native commit as task admission: tx.doc only, no I/O/table reads. Blocked rolls back credit and work. */
	authorizeTransaction?(
		tx: Tx,
		admission: ScheduledAdmission,
		context: Context,
	): Promise<ScheduledAdmissionDecision>;
	/** Rejoin the native request receipt before policy; return the actual settled submission. */
	submitInput?(
		delivery: ScheduledInput,
		context: Context,
	): Promise<SettledSubmissionRecord>;
	/** Submit type:write, rejoin requestId and await its receipt; never wake the parent. */
	writeResult?(
		delivery: ScheduledResult,
		context: Context,
	): Promise<SettledSubmissionRecord>;
}

export const schedulingCapability = defineCapability<SchedulingGrant>(
	"durable.scheduling.v1",
	(value): value is SchedulingGrant =>
		isCapabilityObject(value) &&
		["bindings", "readDefinitions", "authorize", "configure", "onError"].every(
			(name) => typeof value[name] === "function",
		) &&
		[
			"resolveToolBinding",
			"withToolRunAuthorization",
			"authorizeTransaction",
			"submitInput",
			"writeResult",
		].every(
			(name) => value[name] === undefined || typeof value[name] === "function",
		),
);
