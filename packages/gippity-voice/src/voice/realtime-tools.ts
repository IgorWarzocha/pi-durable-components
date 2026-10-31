import type { Agent, ToolExecutionResult } from "@earendil-works/pi-durable";
import { readToolContract } from "../../../execution/src/tool-contract.ts";
import type { PublicRealtimeAccess } from "./realtime-auth.ts";

/** Snapshot selected ordinary registrations once for each public Realtime call. */
export function createRealtimeAccess(
	agent: Agent,
	webSearch: boolean,
	execute: (
		name: string,
		args: unknown,
		context: { signal: AbortSignal; callId: string },
	) => Promise<ToolExecutionResult>,
): PublicRealtimeAccess {
	const tools = agent.tools.filter(
		(tool) =>
			!readToolContract(tool).nativeOnly &&
			agent.callable.some((candidate) => candidate.name === tool.name),
	);
	const selected = new Set<string>();
	for (const tool of tools) {
		if (
			!tool.name ||
			["send_task", "end_call", "web_search"].includes(tool.name) ||
			selected.has(tool.name)
		)
			throw new Error(`Duplicate or reserved voice tool: ${tool.name}`);
		if (Buffer.byteLength(tool.name) > 64 || /[^A-Za-z0-9_-]/.test(tool.name))
			throw new Error(
				"Voice tool names must use at most 64 ASCII letters, digits, underscores or hyphens",
			);
		selected.add(tool.name);
	}
	if (webSearch && !selected.has("web_run"))
		throw new Error(
			"Voice web search is enabled but Web Run is unavailable. Select Web Run or turn off voice web search, then start again.",
		);
	return {
		tools: {
			definitions: [
				...tools.map((tool) => ({
					type: "function" as const,
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
				})),
				...(webSearch
					? [
							{
								type: "function" as const,
								name: "web_search",
								description: "Search the web",
								parameters: {
									type: "object",
									properties: { query: { type: "string" } },
									required: ["query"],
									additionalProperties: false,
								},
							},
						]
					: []),
			],
			async execute(name, args, context) {
				context.signal.throwIfAborted();
				if (name !== "web_search") {
					if (!selected.has(name))
						throw new Error(`Unknown voice tool: ${name}`);
					return execute(name, args, context);
				}
				if (!webSearch) throw new Error("Unknown voice tool: web_search");
				if (
					!args ||
					typeof args !== "object" ||
					Array.isArray(args) ||
					!("query" in args) ||
					typeof args.query !== "string" ||
					!args.query.trim() ||
					Buffer.byteLength(args.query) > 8192 ||
					Object.keys(args).some((key) => key !== "query")
				)
					throw new Error("web_search requires only a nonempty query");
				const result = await execute(
					"web_run",
					{ search_query: [{ q: args.query }] },
					context,
				);
				const text = (result.output ?? [])
					.flatMap((part) => (part.type === "text" ? [part.text] : []))
					.join("\n");
				if (result.isError) throw new Error(text || "Web search failed");
				const maxBytes = 24 * 1024;
				if (Buffer.byteLength(JSON.stringify(text)) <= maxBytes) return text;
				const notice = "\n[Search result truncated; narrow the query]";
				let remaining = maxBytes - Buffer.byteLength(JSON.stringify(notice));
				let excerpt = "";
				for (const character of text) {
					const bytes = Buffer.byteLength(JSON.stringify(character)) - 2;
					if (bytes > remaining) break;
					excerpt += character;
					remaining -= bytes;
				}
				return excerpt + notice;
			},
		},
	};
}
