import {
	type ConversationId,
	defineDoc,
	type TaskId,
} from "@earendil-works/pi-durable";

/** Admission provenance, not authorization: consumers must still verify the live originating slot. */
export type ToolOrigin = {
	conversationId: ConversationId;
	taskId: TaskId;
	callId: string;
};

/** Host-written metadata. Never populated from tool arguments or inferred from the latest turn. */
export const ToolOriginDoc = defineDoc<{ origin?: ToolOrigin }>({
	kind: "howaboua.tool-origin",
	version: 1,
	scope: "task",
	initial: () => ({}),
});
