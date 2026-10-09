/** Ephemeral transport evidence. Contains no authentication headers or credentials. */
export interface CompletionObservation {
	responseId: string;
	provider: string;
	api: string;
	model: string;
	sessionId: string | undefined;
	/** HTTP-equivalent endpoint, including when the request used WebSockets. */
	url: string;
	transport: "sse" | "websocket";
	/** Exact sent JSON, including the WebSocket event envelope. */
	requestBody: string;
	canonicalSubscription: boolean;
}
export type CompletionObserver = (observation: CompletionObservation) => void;
