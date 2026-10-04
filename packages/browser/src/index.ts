import type { JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { environmentArtifactStore } from "./browser/artifact-store.ts";
import { isRecordValue } from "./browser/parse-operation.ts";
import { parseBrowserRequest } from "./browser/request.ts";
import {
	BrowserRuntime,
	type BrowserRuntimeConfig,
} from "./browser/runtime.ts";

export {
	type BrowserArtifactStore,
	environmentArtifactStore,
	nodeArtifactStore,
} from "./browser/artifact-store.ts";
export {
	type BrowserRouteConfig,
	normalizeBrowserRouteConfig,
} from "./browser/config.ts";
export type { BrowserOperation } from "./browser/operation.ts";
export { type BrowserRequest, parseBrowserRequest } from "./browser/request.ts";
export { BrowserRoutes, parseBrowserRoutes } from "./browser/routes.ts";
export {
	type BrowserExecutionOptions,
	BrowserRuntime,
	type BrowserRuntimeConfig,
} from "./browser/runtime.ts";

export function prepareBrowserInput(input: unknown): { command: string } {
	if (typeof input === "string") return { command: input };
	if (!isRecordValue(input))
		throw new Error("browser input must be a command envelope or JSON request");
	if (Object.hasOwn(input, "command")) {
		if (typeof input["command"] !== "string")
			throw new Error(
				'browser command must be "help" or a JSON request string',
			);
		return { ...input, command: input["command"] };
	}
	return { command: JSON.stringify(input) };
}

function isJson(value: unknown): value is JsonValue {
	return (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean" ||
		(typeof value === "number" && Number.isFinite(value)) ||
		(Array.isArray(value) && value.every(isJson)) ||
		(isRecordValue(value) && Object.values(value).every(isJson))
	);
}

export interface BrowserToolOptions {
	/** Artifact directory inside api.env, relative to that environment's cwd. */
	environmentArtifactDirectory?: string;
}

export function createBrowserTool(
	runtime: BrowserRuntime,
	options: BrowserToolOptions = {},
) {
	return defineTool({
		name: "browser",
		description: "Control logged-in browser; call help before other actions",
		parameters: Type.Object(
			{ command: Type.String({ description: "help or JSON request" }) },
			{ additionalProperties: false },
		),
		prepareArguments: prepareBrowserInput,
		replay: "unsafe",
		// Operations already bound output and expose continuation handles.
		// Framework truncation would corrupt batch JSON and hide later cursors.
		outputLimits: {
			maxBytes: Number.MAX_SAFE_INTEGER,
			maxLines: Number.MAX_SAFE_INTEGER,
		},
		async execute(input, api, context) {
			const artifacts = api.env
				? await environmentArtifactStore(
						api.env,
						options.environmentArtifactDirectory ?? ".pi/browser",
						context,
					)
				: undefined;
			const result = await runtime.execute(parseBrowserRequest(input.command), {
				ownerId: String(api.conversationId),
				signal: context.abortSignal,
				artifacts,
				async onOperation(operation, index, total) {
					api.output(
						total === 1
							? `Browser ${operation.action}\n`
							: `Browser ${operation.action} ${index + 1}/${total}\n`,
					);
					await api.details(
						{
							action: operation.action,
							index: index + 1,
							total,
							status: "running",
						},
						context,
					);
				},
			});
			// CDP may contain absent optional fields. Match JSON wire semantics before
			// crossing Durable's strict JSON document boundary.
			const text = JSON.stringify(result);
			const details: unknown = JSON.parse(text);
			if (!isJson(details))
				throw new Error("Browser returned a non-JSON result");
			return { content: [{ type: "text", text }], details };
		},
	});
}

/** The host explicitly authorizes native CDP, launch, SSH and private state IO.
 * The host must await close() before discarding this process-local runtime. */
export function createBrowserExtension(
	config: BrowserRuntimeConfig & BrowserToolOptions,
) {
	const runtime = new BrowserRuntime(config);
	const tool = createBrowserTool(runtime, config);
	return {
		runtime,
		tool,
		extension: defineExtension({ name: "browser", tools: [tool] }),
		close: () => runtime.close(),
	};
}
