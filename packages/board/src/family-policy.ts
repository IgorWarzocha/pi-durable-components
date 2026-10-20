import type { ConversationId } from "@earendil-works/pi-durable";
import { defineDoc } from "@earendil-works/pi-durable";

/** Host grants are separate from local membership and never follow task ownership. */
export const BoardFamilies = defineDoc<{
	families: Record<
		string,
		{
			anchorConversationId: ConversationId;
			residentConversationId: ConversationId | null;
			participants: Record<string, string>;
			threads: Record<string, string>;
		}
	>;
}>({
	kind: "howaboua.board.families",
	version: 1,
	scope: "session",
	initial: () => ({ families: {} }),
});
