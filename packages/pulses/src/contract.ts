import type { Context } from "@earendil-works/chord";
import type {
	ConversationId,
	SettledSubmissionRecord,
	TaskId,
	ToolExecutionApi,
	Tx,
} from "@earendil-works/pi-durable";
import type { PulseDefinition } from "./definitions.ts";

export type PulseBinding = {
	key: string;
	root: string;
	parentConversationId?: ConversationId;
};
export type PulseSource = { id: string; text: string; error?: string };
export type PulseRunRequest = {
	bindingKey: string;
	pulseId: string;
	requestId: string;
};
export type PulseTrigger = "manual" | "scheduled";
export type PulseOccurrence = { count: number; startAt: number; endAt: number };
export type PulseAdmission = {
	binding: PulseBinding;
	definition: PulseDefinition;
	trigger: PulseTrigger;
	requestId: string;
	taskId: TaskId;
	conversationId: ConversationId;
	occurrence?: PulseOccurrence;
};
export type PulseAdmissionDecision =
	| { status: "accepted" }
	| { status: "blocked"; reason: string; retryAt?: number };
export type PulseInputDelivery = {
	conversationId: ConversationId;
	taskId: TaskId;
	requestId: string;
	content: string;
};
/** The abort-before-dispatch case has a native task outcome but no submission receipt. */
export type PulseOutcome = SettledSubmissionRecord | { status: "aborted" };
export type PulseResultDelivery = {
	parentConversationId: ConversationId;
	conversationId: ConversationId;
	taskId: TaskId;
	outcome: PulseOutcome;
	requestId: string;
	title: string;
	text: string;
	occurrence?: PulseOccurrence;
};
export interface PulsesOptions {
	/** Resolve the caller's authorised binding in api.env. Never infer from global bindings or host paths. */
	resolveToolBinding?(api: ToolExecutionApi, context: Context): Promise<string>;
	/** After receipt lookup, outside the admission queue. Establish caller scope only; defer actual authorisation to admit, since run() rejoins receipts again. Never infer authority from request IDs. admitTransaction owns atomic policy/credit with task creation. Call run at most once and return its result; no external side effects. */
	withToolRunAuthorization?(
		api: ToolExecutionApi,
		request: PulseRunRequest,
		run: () => Promise<TaskId | undefined>,
		context: Context,
	): Promise<TaskId | undefined>;
	/** Initial limit only. Persisted changes through setConcurrency survive rebinding. */
	concurrency?: number;
	getBindings(context: Context): Promise<readonly PulseBinding[]>;
	/** Read immediate pulse directories in the explicit execution environment. Never modify files. */
	readDefinitions(
		binding: PulseBinding,
		context: Context,
	): Promise<readonly PulseSource[]>;
	/** Prepare environment data and preflight every new admission. Race-safe policy/credit belongs in admitTransaction. */
	admit(
		binding: PulseBinding,
		definition: PulseDefinition,
		trigger: PulseTrigger,
		context: Context,
	): Promise<void>;
	/** Same native transaction as createTask. Blocked rolls back ALL changes, including policy credit. Use tx.doc only: table reads after createTask are forbidden. No filesystem, network, Harness reads or irreversible effects. Receipt retries bypass this hook. */
	admitTransaction?(
		tx: Tx,
		admission: PulseAdmission,
		context: Context,
	): Promise<PulseAdmissionDecision>;
	/** Deliver already accepted work. Validate native task lineage and rejoin requestId before new input policy; return the actual settled input receipt. */
	submitInput?(
		delivery: PulseInputDelivery,
		context: Context,
	): Promise<SettledSubmissionRecord>;
	/** Transaction-only configuration on every NEW child admission, never the resident target. Prepare data in admit. Use document operations only, no table reads or filesystem/model I/O. Configure cwd=root and fresh pulse-home instructions without accumulating old instructions; preserve native parent models/tools/extensions. */
	configure(
		tx: Tx,
		conversationId: ConversationId,
		binding: PulseBinding,
		definition: PulseDefinition,
		creation: { created: boolean },
	): Promise<void>;
	/** Must submit type:write with requestId and await its native receipt. Never wake the parent. */
	writeResult?(
		delivery: PulseResultDelivery,
		context: Context,
	): Promise<SettledSubmissionRecord>;
	onError(error: unknown): void;
}
