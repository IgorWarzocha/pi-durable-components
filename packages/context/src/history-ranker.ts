import type { ConversationId } from "@earendil-works/pi-durable";

export type HistoryIndexRequest = {
	scope: string;
	items: readonly { id: string; content: string }[];
	signal?: AbortSignal | undefined;
};

/** A host-granted derived terms index. Contents must come only from retired visible text. */
export interface HistoryRanker {
	/** Replace the complete eligible corpus for this scope, removing stale rows. */
	refresh(request: HistoryIndexRequest): Promise<void>;
	search(
		request: HistoryIndexRequest & {
			query: string;
			limit: number;
			recentFirst: boolean;
		},
	): Promise<string[]>;
}

/** Omitted means off. The callback is read on every tool call for live settings. */
export type RankedHistory = {
	ranker: HistoryRanker;
	enabled?: (conversationId: ConversationId) => boolean;
};
