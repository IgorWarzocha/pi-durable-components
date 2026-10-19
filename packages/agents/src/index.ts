import type { Harness, Storage } from "@earendil-works/pi-durable";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { AgentsOptions } from "./contract.ts";
import { AgentsParameters, help } from "./contract.ts";
import { delegate, send } from "./delegation.ts";
import { createHostAccess } from "./host.ts";
import { discoverAgents } from "./queries.ts";
import { Anchor, Completion, Dispatch } from "./tasks.ts";
import type { AgentsBinding } from "./watch.ts";
import { createWatch } from "./watch.ts";
import { updateSubscription } from "./watch-subscription.ts";

export type { AgentProfile, AgentsOptions } from "./contract.ts";
export { AgentsParameters } from "./contract.ts";
export type { AgentMessage, AgentObservation } from "./host.ts";

/** Install before opening, bind the Harness and storage before scheduling, and select on controllers. */
export function createAgents(options: AgentsOptions) {
	let host: AgentsBinding | undefined;
	const binding = () => {
		if (host === undefined)
			throw new Error(
				"Bind the Agents component before using host access or persistent watches. Delegation and tool send remain available",
			);
		return host;
	};
	const Watch = createWatch(binding);
	const registration = defineTool({
		name: "agents",
		description: "Delegate to persistent agents",
		parameters: AgentsParameters,
		replay: "safe",
		executionMode: "sequential",
		// Delegation results retain full replies.
		outputLimits: {
			maxBytes: Number.MAX_SAFE_INTEGER,
			maxLines: Number.MAX_SAFE_INTEGER,
		},
		execute: async (args, api, context) => {
			switch (args.action) {
				case undefined:
				case "help":
					return help(options.profiles);
				case "list":
				case "find":
					return discoverAgents(args, api, context);
				case "watch":
				case "unwatch":
					return updateSubscription(args, api, context, Watch, binding);
				case "send":
					return send(args, api, context);
				case "spawn":
				case "assign":
					return delegate(args, api, context, options);
			}
			throw new Error("Invalid agents request; call agents with {} for help");
		},
	});
	const tool = {
		...registration,
		executionHints: { discovery: "help" as const },
	};
	const extension = defineExtension({
		name: "howaboua.agents",
		tools: [tool],
		tasks: [Anchor, Dispatch, Completion, Watch],
	});
	return {
		...createHostAccess(binding),
		extension,
		tool,
		bind(harness: Harness, storage: Storage) {
			if (
				host !== undefined &&
				(host.harness !== harness || host.storage !== storage)
			) {
				throw new Error("Create a separate agents component for each Harness");
			}
			host = { harness, storage };
		},
		/** Release only after the host has closed this Harness and its task invocations. */
		unbind(harness: Harness) {
			if (host?.harness === harness) host = undefined;
		},
	};
}
