import type { JsonValue } from "@earendil-works/chord";
import type {
	ConversationId,
	Cursor,
	SubmissionRecord,
	TaskRecord,
	Tx,
} from "@earendil-works/pi-durable";
import { pulseInputRequestId } from "./tasks.ts";

export type PulseExecutionRequest = {
	bindingKey: string;
	pulseId: string;
	conversationId: ConversationId;
};

/** Latest admitted execution for this exact job and conversation, including historical targets. */
export async function execution(
	tx: Tx,
	request: PulseExecutionRequest,
): Promise<
	| {
			task: TaskRecord<JsonValue, JsonValue, JsonValue>;
			submission: Extract<SubmissionRecord, { type: "input" }> | undefined;
	  }
	| undefined
> {
	let cursor: Cursor | undefined;
	do {
		const page = await tx.scanTasks(
			{
				kind: "howaboua.pulses.run",
				conversationId: request.conversationId,
				order: "descending",
			},
			100,
			cursor,
		);
		for (const task of page.items) {
			const input = task.input;
			if (typeof input !== "object" || input === null || Array.isArray(input))
				throw new Error("Invalid admitted pulse input");
			const binding = input["binding"];
			const definition = input["definition"];
			if (
				typeof binding !== "object" ||
				binding === null ||
				Array.isArray(binding) ||
				typeof definition !== "object" ||
				definition === null ||
				Array.isArray(definition)
			)
				throw new Error("Invalid admitted pulse identity");
			if (
				binding["key"] !== request.bindingKey ||
				definition["id"] !== request.pulseId
			)
				continue;
			const reference = input["reference"];
			if (
				typeof reference !== "object" ||
				reference === null ||
				Array.isArray(reference) ||
				reference["conversationId"] !== task.conversationId
			)
				throw new Error("Invalid admitted pulse conversation reference");
			const submission = await tx.submissionByRequest(
				task.conversationId,
				pulseInputRequestId(task.id),
			);
			if (submission !== undefined && submission.type !== "input")
				throw new Error("Invalid pulse input submission");
			// An undispatched task has no receipt; never substitute an older run.
			return { task, submission };
		}
		cursor = page.next;
	} while (cursor !== undefined);
	return undefined;
}
