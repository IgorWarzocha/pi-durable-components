import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";
import {
	defineTool,
	type ModelRef,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import {
	type FileInfo,
	type FileSystem,
	getOrThrow,
} from "@earendil-works/pi-durable/env";
import { Type } from "typebox";
import { createImageCodec, type ViewImageContent } from "./codec.ts";
import { describeImage } from "./description.ts";

export type { ViewImageContent } from "./codec.ts";

export interface ViewImageOptions {
	/** Supply the same collection passed to Harness.open(). */
	models: Models;
	describeForTextModels?: boolean;
	/** Defaults to gpt-6-luna in the caller's provider. */
	descriptionModel?: ModelRef;
}

export type ViewImageDetails =
	| { viewImage: true }
	| {
			viewImageDescription: {
				image: ViewImageContent;
				path: string;
				description: string;
			};
	  };

const schema = Type.Object({
	path: Type.String(),
	detail: Type.Optional(Type.Literal("original")),
});

/** Durable registration. Ordinary registry discovery also exposes this tool to Code and Notebook. */
export function createViewImageTool(
	options: ViewImageOptions,
): ToolRegistration<typeof schema, ViewImageDetails> {
	const loadImage = createImageCodec();
	return defineTool<typeof schema, ViewImageDetails>({
		name: "view_image",
		description: "View image",
		parameters: schema,
		// A description request can incur charges. Never replay an interrupted request automatically.
		replay: options.describeForTextModels ? "unsafe" : "safe",
		prepareArguments: prepareArguments,
		async execute(args, api, context) {
			context.abortSignal?.throwIfAborted();
			const agent = await api.agent(context);
			if (!agent.model)
				throw new Error("view_image requires a conversation model");
			const model = options.models.getModel(
				agent.model.provider,
				agent.model.modelId,
			);
			if (!model)
				throw new Error(
					`view_image model not found: ${agent.model.provider}/${agent.model.modelId}`,
				);
			const vision = model.input.includes("image");
			if (!vision && !options.describeForTextModels) {
				throw new Error(
					"view_image is not allowed because you do not support image inputs",
				);
			}
			if (!api.env)
				throw new Error("view_image requires an execution environment");
			const path = await locateImage(api.env, args.path, context);
			let bytes: Uint8Array;
			try {
				bytes = getOrThrow(await api.env.readBinaryFile(path, context));
			} catch (cause) {
				context.abortSignal?.throwIfAborted();
				throw new Error(
					`unable to read image at \`${path}\`: ${cause instanceof Error ? cause.message : String(cause)}`,
					{ cause },
				);
			}
			const image = await loadImage(bytes, path, context.abortSignal);
			if (vision) return { content: [image], details: { viewImage: true } };
			const { description, usage } = await describeImage(
				image,
				options.models,
				agent.model,
				options.descriptionModel,
				context,
			);
			return {
				content: [{ type: "text", text: description }],
				details: {
					viewImageDescription: { image, path: args.path, description },
				},
				usage,
			};
		},
	});
}

function prepareArguments(args: unknown): {
	path: string;
	detail?: "original";
} {
	if (!args || typeof args !== "object")
		throw new Error("view_image requires a string 'path' parameter");
	const record = args as Record<string, unknown>;
	const path =
		"path" in record
			? record["path"]
			: "file_path" in record
				? record["file_path"]
				: record["image_path"];
	if (typeof path !== "string")
		throw new Error("view_image requires a string 'path' parameter");
	const detail = record["detail"];
	if (detail !== undefined && detail !== null && typeof detail !== "string")
		throw new Error("view_image.detail must be a string when provided");
	if (typeof detail === "string" && detail !== "original")
		throw new Error(
			`view_image.detail only supports \`original\`, got \`${detail}\``,
		);
	return {
		path: path.startsWith("@") ? path.slice(1) : path,
		...(detail === "original" ? { detail } : {}),
	};
}

async function locateImage(
	env: FileSystem,
	input: string,
	context: Context,
): Promise<string> {
	const path = getOrThrow(await env.absolutePath(input, context));
	let info: FileInfo;
	try {
		info = getOrThrow(await env.fileInfo(path, context));
		// Durable fileInfo is lstat. Rust metadata follows symlinks, including links to directories.
		if (info.kind === "symlink")
			info = getOrThrow(
				await env.fileInfo(
					getOrThrow(await env.canonicalPath(path, context)),
					context,
				),
			);
	} catch (cause) {
		context.abortSignal?.throwIfAborted();
		throw new Error(
			`unable to locate image at \`${path}\`: ${cause instanceof Error ? cause.message : String(cause)}`,
			{ cause },
		);
	}
	if (info.kind !== "file")
		throw new Error(`image path \`${path}\` is not a file`);
	return path;
}
