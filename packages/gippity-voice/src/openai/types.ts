export interface WebSocketLike {
	readyState?: number | undefined;
	/** Owned transport and dispatcher teardown, when supplied by the native connector. */
	closed?: Promise<void>;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: string, listener: (event: unknown) => void): void;
	removeEventListener(type: string, listener: (event: unknown) => void): void;
}
