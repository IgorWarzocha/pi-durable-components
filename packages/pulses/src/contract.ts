import type { Context } from "@earendil-works/chord";
import type {
	ConversationId,
	SettledSubmissionRecord,
	TaskId,
	Tx,
} from "@earendil-works/pi-durable";
import type { PulseDefinition } from "./definitions.ts";

export type PulseBinding = {
	key: string;
	root: string;
	parentConversationId?: ConversationId;
};
export type PulseSource = { id: string; text: string; error?: string };
export type PulseTrigger = "manual" | "scheduled";
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
};
export interface PulsesOptions {
	getBindings(context: Context): Promise<readonly PulseBinding[]>;
	/** Read immediate pulse directories in the explicit execution environment. Never modify files. */
	readDefinitions(
		binding: PulseBinding,
		context: Context,
	): Promise<readonly PulseSource[]>;
	/** Authorize every new admission, including the current optional parent's external-input policy. */
	admit(
		binding: PulseBinding,
		definition: PulseDefinition,
		trigger: PulseTrigger,
		context: Context,
	): Promise<void>;
	/** Transaction-only native configuration on every NEW admission. Prepare data in admit; no filesystem/model I/O here. Configure cwd=root and fresh applicable pulse-home instructions without accumulating old local instructions; preserve native parent models/tools/extensions. Native ownership and identity change only with the parent ID. */
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
