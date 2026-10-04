// Adapted from pi-codex-conversion at b2006db9def12c373ae48e70044d30f7d6b7e34f, MIT. See ../NOTICE.
import type { NotebookSessionContext } from "./runtime-contract.ts";

export function notebookSessionIdentity(
	context: NotebookSessionContext,
): string {
	return context.sessionId;
}
