/** Host-owned roster page and optional latest reply. No acquisition occurs here. */
export interface AgentRosterItem {
	target: string;
	name: string;
	label: string;
	profile: string;
	status: "idle" | "working";
	watched: boolean;
}
export interface AgentsPresentationState {
	agents: AgentRosterItem[];
	detail: { target: string; reply: string | null; truncated: boolean } | null;
}

function object(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new TypeError("Expected an object");
	return Object.fromEntries(Object.entries(value));
}
function string(value: unknown): string {
	if (typeof value !== "string") throw new TypeError("Expected a string");
	return value;
}
function array<T>(value: unknown, parse: (item: unknown) => T): T[] {
	if (!Array.isArray(value)) throw new TypeError("Expected an array");
	return value.map(parse);
}

function parseAgent(value: unknown): AgentRosterItem {
	const item = object(value);
	if (item["status"] !== "idle" && item["status"] !== "working")
		throw new TypeError("Invalid agent status");
	if (typeof item["watched"] !== "boolean")
		throw new TypeError("Invalid watch state");
	return {
		target: string(item["target"]),
		name: string(item["name"]),
		label: string(item["label"]),
		profile: string(item["profile"]),
		status: item["status"],
		watched: item["watched"],
	};
}
export function parseAgentsPresentationState(
	value: unknown,
): AgentsPresentationState {
	const state = object(value);
	const agents = array(state["agents"], parseAgent);
	let detail: AgentsPresentationState["detail"] = null;
	if (state["detail"] !== null) {
		const item = object(state["detail"]);
		if (typeof item["truncated"] !== "boolean")
			throw new TypeError("Invalid truncation state");
		detail = {
			target: string(item["target"]),
			reply: item["reply"] === null ? null : string(item["reply"]),
			truncated: item["truncated"],
		};
		if (!agents.some((agent) => agent.target === detail?.target))
			throw new TypeError("Detail target is absent from the roster page");
	}
	return { agents, detail };
}
export const agentsCapability = {
	id: "agents",
	version: 1,
	parseState: parseAgentsPresentationState,
	actions: ["agents"],
	streams: [],
	presentations: ["agents.summary", "agents.detail"],
};
export const agentsSummaryPresentation = {
	id: "agents.summary",
	requests: ["agents.detail"],
	select(state: AgentsPresentationState) {
		return {
			total: state.agents.length,
			working: state.agents.filter((agent) => agent.status === "working")
				.length,
			watched: state.agents.filter((agent) => agent.watched).length,
			agents: state.agents,
		};
	},
};
export const agentsDetailPresentation = {
	id: "agents.detail",
	requests: [],
	select: (state: AgentsPresentationState) => state.detail,
};
