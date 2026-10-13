import type { Models } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { Type } from "typebox";
import { getSitesAuth } from "./auth.ts";
import { SitesClient } from "./client.ts";
import { documentation } from "./documentation.ts";
import { call } from "./facade.ts";
import type { SitesProjectCapability } from "./local-project.ts";
import { boundedJson } from "./redact.ts";

export type {
	ProjectContext,
	SitesProjectCapability,
} from "./local-project.ts";
export { createNativeSitesProjectCapability } from "./native-project.ts";

export interface SitesOptions {
	models: Models;
	/** Explicit Codex OAuth provider, default openai-codex. Its route must be canonical ChatGPT. */
	providerId?: string;
	/** No host fallback. A returned capability must own the conversation's exact namespace. */
	projectForEnvironment(
		environment: ExecutionEnv,
	): SitesProjectCapability | undefined;
	/** Host-owned egress, never a configurable backend URL. */
	fetch?: typeof globalThis.fetch;
}

export const SITES_PARAMETERS = Type.Object(
	{
		resource: Type.Optional(Type.String()),
		action: Type.Optional(Type.String()),
		params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	},
	{ additionalProperties: false },
);

export const SITES_DOCUMENTATION_PARAMETERS = Type.Object(
	{
		topic: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

// Preserve the source's structured error and bounded result contract.
async function result(run: () => Promise<unknown>) {
	try {
		const value = await run();
		const text = typeof value === "string" ? value : boundedJson(value);
		if (text.startsWith("{")) {
			const parsed: unknown = JSON.parse(text);
			if (
				parsed &&
				typeof parsed === "object" &&
				"ok" in parsed &&
				parsed.ok === false &&
				"error" in parsed &&
				parsed.error &&
				typeof parsed.error === "object" &&
				"message" in parsed.error
			) {
				throw Object.assign(
					new Error(String(parsed.error.message)),
					parsed.error,
				);
			}
		}
		return { output: [{ type: "text" as const, text }] };
	} catch (error) {
		const info = error instanceof Error ? error : new Error(String(error));
		throw new Error(
			boundedJson({
				ok: false,
				error: {
					code: "code" in info ? (info.code ?? "sites_error") : "sites_error",
					message: info.message,
					topic: "topic" in info ? info.topic : undefined,
					terms_url: "termsUrl" in info ? info.termsUrl : undefined,
					status: "status" in info ? info.status : undefined,
					details: "details" in info ? info.details : undefined,
				},
			}),
		);
	}
}

export function createSitesTool(options: SitesOptions) {
	return defineTool({
		name: "sites",
		description:
			"Manage ChatGPT Sites. No arguments or action:help returns help",
		parameters: SITES_PARAMETERS,
		replay: "unsafe",
		outputLimits: { maxBytes: 32_000, maxLines: Number.MAX_SAFE_INTEGER },
		async execute(args, api, context) {
			return result(async () => {
				const client = new SitesClient({
					authProvider: () =>
						getSitesAuth(
							options.models,
							options.providerId ?? "openai-codex",
							context,
						),
					signal: context.abortSignal,
					...(options.fetch ? { fetchImpl: options.fetch } : {}),
				});
				if (Object.keys(args).length === 0 || args.action === "help")
					return documentation("index", client);
				context.abortSignal?.throwIfAborted();
				if (!api.env)
					throw new Error(
						"Sites requires a conversation execution environment",
					);
				const project = options.projectForEnvironment(api.env);
				if (!project || project.id !== api.env.id)
					throw new Error(
						"Sites has no project capability for this execution namespace",
					);
				return call(args, client, api.env.cwd, project, context);
			});
		},
	});
}

export function createSitesDocumentationTool(
	options: Pick<SitesOptions, "models" | "providerId" | "fetch">,
) {
	return defineTool({
		name: "sites_documentation",
		description: "Sites guide or current resource.action parameter schema",
		parameters: SITES_DOCUMENTATION_PARAMETERS,
		replay: "safe",
		outputLimits: { maxBytes: 16_000, maxLines: Number.MAX_SAFE_INTEGER },
		async execute(args, _api, context) {
			return result(() =>
				documentation(
					args.topic === "help" ? "index" : args.topic,
					new SitesClient({
						authProvider: () =>
							getSitesAuth(
								options.models,
								options.providerId ?? "openai-codex",
								context,
							),
						signal: context.abortSignal,
						...(options.fetch ? { fetchImpl: options.fetch } : {}),
					}),
				),
			);
		},
	});
}

export function createSitesExtension(options: SitesOptions) {
	return defineExtension({
		name: "sites",
		tools: [createSitesTool(options), createSitesDocumentationTool(options)],
	});
}
