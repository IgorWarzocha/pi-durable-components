import { executionHistory } from "../../execution/src/history.ts";

export type { ExecutionHistoryRequest } from "../../execution/src/history.ts";
export const readForwardedToolCalls = executionHistory("code");
