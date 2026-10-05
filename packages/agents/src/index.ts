import type { Harness, Storage } from "@earendil-works/pi-durable";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { changeMembership } from "./board/membership.ts";
import { createBoardNoticeHooks } from "./board/notice-hooks.ts";
import { createBoardTool } from "./board/tool.ts";
import type { AgentsOptions } from "./contract.ts";
import { AgentsParameters, help } from "./contract.ts";
import { delegate, send } from "./delegation.ts";
import { discoverAgents, readAgent } from "./queries.ts";
import { Anchor, Completion, Dispatch } from "./tasks.ts";
import type { AgentsBinding } from "./watch.ts";
import { createWatch } from "./watch.ts";
import { updateSubscription } from "./watch-subscription.ts";

export {
	readSavedThreads,
	type SavedPost,
	type SavedThread,
} from "./board/saved-threads.ts";
export type { AgentProfile, AgentsOptions } from "./contract.ts";
export { AgentsParameters } from "./contract.ts";

/** Install before opening, bind the Harness and storage before scheduling, and select on controllers. */
export function createAgents(options: AgentsOptions) {
	let host: AgentsBinding | undefined;
	const binding = () => {
		if (host === undefined)
			throw new Error(
				"Bind the Agents component before using persistent watches or board posts. Delegation and message-only send remain available",
			);
		return host;
	};
	const Watch = createWatch(binding);
	const tool = defineTool({
		name: "agents",
		description: "Delegate to persistent agents; call help first",
		parameters: AgentsParameters,
		replay: "safe",
		executionMode: "sequential",
		// Delegation results retain full replies. Only read applies an intentional output bound.
		outputLimits: {
			maxBytes: Number.MAX_SAFE_INTEGER,
			maxLines: Number.MAX_SAFE_INTEGER,
		},
		execute: async (args, api, context) => {
			switch (args.action) {
				case "help":
					return help(options.profiles);
				case "list":
				case "find":
					return discoverAgents(args, api, context);
				case "read":
					return readAgent(args, api, context);
				case "watch":
				case "unwatch":
					return updateSubscription(args, api, context, Watch, binding);
				case "send":
					return send(args, api, context);
				case "attach":
				case "detach":
					return changeMembership(args, api, context);
				case "spawn":
				case "assign":
					return delegate(args, api, context, options.profiles);
			}
		},
	});
	const boardTool = createBoardTool(binding);
	const extension = defineExtension({
		name: "howaboua.agents",
		tools: [tool, boardTool],
		tasks: [Anchor, Dispatch, Completion, Watch],
		hooks: createBoardNoticeHooks(binding),
	});
	return {
		extension,
		tool,
		boardTool,
		bind(harness: Harness, storage: Storage) {
			if (
				host !== undefined &&
				(host.harness !== harness || host.storage !== storage)
			) {
				throw new Error("Create a separate agents component for each Harness");
			}
			host = { harness, storage };
		},
	};
}
