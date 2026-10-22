import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import type { ConversationId, Storage, Tx } from "@earendil-works/pi-durable";
import { createSession, defineDoc } from "@earendil-works/pi-durable";

const SHARED_GROUP = "shared";

/** Missing records retain shared-storage behavior. Rewinds preserve policy; forks inherit it. */
const ContextVisibility = defineDoc<{ group: string }>({
	kind: "howaboua.context.visibility",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	checkpointWhen: () => true,
	initial: () => ({ group: SHARED_GROUP }),
});

/** Persist an immutable group for a newly created child before dispatching its first task. */
export async function assignContextVisibility(
	tx: Tx,
	parent: ConversationId,
	child: ConversationId,
	shareContext: boolean | undefined,
): Promise<void> {
	const parentState = await tx.doc(ContextVisibility, parent);
	const group =
		shareContext === false ? `private:${randomUUID()}` : parentState.group;
	const childState = await tx.doc(ContextVisibility, child);
	childState.group = group;
}

/** Foreign Context reads require exact group equality; absent records mean legacy shared storage. */
export async function canReadContextTarget(
	storage: Storage,
	caller: ConversationId,
	target: ConversationId,
	context: Context,
): Promise<boolean> {
	const reader = createSession(storage);
	const [callerState, targetState] = await Promise.all([
		reader.snapshot(ContextVisibility, caller, context),
		reader.snapshot(ContextVisibility, target, context),
	]);
	return (
		(callerState?.group ?? SHARED_GROUP) ===
		(targetState?.group ?? SHARED_GROUP)
	);
}
