import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
	createRegistry,
	Harness,
	MemoryStorage,
	ProviderDoc,
} from "@earendil-works/pi-durable";
import { createWebSearchExtension } from "../src/index.ts";

const context = BACKGROUND_CONTEXT;

// Controlled HTTP transport fixture, not evidence of subscription backend compatibility.
export default {
	async fetch(request: Request) {
		const url = new URL(request.url);
		const target = url.searchParams.get("fixture");
		if (!target) return new Response("Missing owned fixture", { status: 400 });
		const models = createModels();
		const provider = fauxProvider();
		models.setProvider(provider.provider);
		const extension = createWebSearchExtension({
			models,
			runtime: "workerd",
			resolveProvider: async () => ({
				route: "openai-codex",
				baseUrl: target,
				responsesUrl: target,
				searchUrl: target,
				model: undefined,
				token: "owned-fixture-not-a-credential",
				accountId: "owned-fixture-account",
			}),
		});
		const registry = createRegistry();
		registry.install(extension);
		const observations: ToolResultMessage[] = [];
		provider.setResponses([
			() =>
				fauxAssistantMessage(
					fauxToolCall("web_run", {
						search_query: [{ q: "owned transport fixture", custom_query: 42 }],
						custom_command: { retained: true },
						settings: { search_context_size: "high", custom_setting: true },
						max_output_tokens: 1,
					}),
					{ stopReason: "toolUse" },
				),
			(request) => {
				const result = request.messages.findLast(
					(message) => message.role === "toolResult",
				);
				if (result?.role === "toolResult") observations.push(result);
				return url.pathname === "/affinity" && !result?.isError
					? fauxAssistantMessage(
							fauxToolCall("web_run", { open: [{ ref_id: "owned-turn-ref" }] }),
							{ stopReason: "toolUse" },
						)
					: fauxAssistantMessage("done");
			},
			(request) => {
				const result = request.messages.findLast(
					(message) => message.role === "toolResult",
				);
				if (result?.role === "toolResult") observations.push(result);
				return fauxAssistantMessage("done");
			},
		]);
		const storage = new MemoryStorage();
		const harness = await Harness.open(
			storage,
			{ models, registry, settings: { retry: { enabled: false } } },
			context,
		);
		try {
			const root = await harness.root(context, {
				agent: {
					model: { provider: "faux", modelId: "faux-1" },
					extensions: [extension],
				},
			});
			const submission = await root.submit(
				{ type: "input", content: "Exercise owned HTTP transport" },
				context,
			);
			if (url.pathname === "/cancel") {
				// Abort after the fixture confirms that the request body has arrived.
				const ready = new URL(target);
				ready.pathname = "/ready";
				await fetch(ready);
				await root.abort(context);
			}
			const receipt = await submission.wait(context);
			const session = await harness.snapshot(ProviderDoc, root.id, context);
			return Response.json({
				observations,
				receipt,
				sessionId: session?.sessionId,
			});
		} finally {
			await harness.close(context);
		}
	},
};
