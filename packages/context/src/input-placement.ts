import type { Context } from "@earendil-works/chord";
import type { TaskId } from "@earendil-works/pi-durable";
import type { ComponentInputPlacement } from "@howaboua/pi-durable-components";
import { type ContextHost, INPUT_TASK, type InputResult } from "./lifecycle.ts";

/** Observe this component's native receipt, not its final answer or private checkpoint layout. */
export async function waitForInputPlacement(
	host: ContextHost,
	id: TaskId<InputResult>,
	context: Context,
): Promise<ComponentInputPlacement> {
	const requestId = `context:input:${id}`;
	let revision = 0;
	let closing = false;
	let wake: (() => void) | undefined;
	const changed = () => {
		revision++;
		wake?.();
	};
	// Subscribe before reading. Native placement can commit before the task observes it.
	const unsubscribe = host.harness.subscribeCommits((publication) => {
		if (
			publication.changes.some(
				(change) =>
					(change.type === "task" && change.value.id === id) ||
					(change.type === "submission" &&
						change.value.requestId === requestId),
			)
		)
			changed();
	});
	const stopClose = host.harness.subscribeClose(() => {
		closing = true;
		changed();
	});
	try {
		while (true) {
			context.abortSignal?.throwIfAborted();
			if (closing)
				throw new Error(
					"Context host closed before input placement was observed",
				);
			const before = revision;
			const task = await host.harness.getTask(id, context);
			if (!task || task.kind !== INPUT_TASK)
				throw new Error("Input task does not belong to Context management");
			const submission = await host.harness.commit(
				(tx) => tx.submissionByRequest(task.conversationId, requestId),
				context,
			);
			if (submission)
				return { status: "submitted", submissionId: submission.id };
			if (
				task.state.status === "terminal" ||
				task.state.status === "completing"
			) {
				const outcome = task.state.outcome;
				if (outcome.status === "aborted")
					return {
						status: "aborted",
						...(outcome.reason ? { reason: outcome.reason } : {}),
					};
				return {
					status: "failed",
					message:
						outcome.status === "failed" || outcome.status === "faulted"
							? outcome.error.message
							: outcome.status === "orphaned"
								? outcome.reason
								: "Managed input completed without a native submission receipt",
				};
			}
			if (revision !== before) continue;
			await new Promise<void>((resolve, reject) => {
				const signal = context.abortSignal;
				const abort = () => {
					wake = undefined;
					reject(signal?.reason);
				};
				wake = () => {
					signal?.removeEventListener("abort", abort);
					wake = undefined;
					resolve();
				};
				signal?.addEventListener("abort", abort, { once: true });
				if (signal?.aborted) abort();
				else if (revision !== before || closing) wake();
			});
		}
	} finally {
		unsubscribe();
		stopClose();
	}
}
