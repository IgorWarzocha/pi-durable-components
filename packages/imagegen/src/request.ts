import type { Context } from "@earendil-works/chord";
import { type ExecutionEnv, getOrThrow } from "@earendil-works/pi-durable/env";
import { IMAGE_MODEL, type ImagegenArgs, MAX_EDIT_IMAGES } from "./contract.ts";
import { validatedImageMime } from "./image-validation.ts";

const MAX_IMAGE_BYTES = 1024 * 1024 * 1024;

async function localImageDataUrl(
	value: string,
	env: ExecutionEnv,
	context: Context,
): Promise<string> {
	const path = getOrThrow(
		await env.canonicalPath(
			getOrThrow(await env.absolutePath(value, context)),
			context,
		),
	);
	const info = getOrThrow(await env.fileInfo(path, context));
	if (info.kind !== "file")
		throw new Error("edit image is not a file: " + value);
	if (info.size > MAX_IMAGE_BYTES)
		throw new Error(
			"edit image exceeds " + MAX_IMAGE_BYTES + " bytes: " + value,
		);
	const bytes = getOrThrow(await env.readBinaryFile(path, context));
	const mime = validatedImageMime(bytes);
	if (!mime)
		throw new Error("edit image must be PNG, JPEG, GIF, or WebP: " + value);
	return "data:" + mime + ";base64," + Buffer.from(bytes).toString("base64");
}

function recentImageDataUrl(value: string): string {
	const separator = value.indexOf(",");
	const metadata = separator >= 0 ? value.slice(0, separator) : "";
	const data = separator >= 0 ? value.slice(separator + 1) : "";
	if (
		!metadata.startsWith("data:image/") ||
		!metadata.endsWith(";base64") ||
		!data
	)
		throw new Error("recent conversation image is not a base64 image data URL");
	return value;
}

export async function buildImageGenerationRequest(
	args: ImagegenArgs,
	recentImages: string[] | undefined,
	env: ExecutionEnv,
	context: Context,
	model: string = IMAGE_MODEL,
): Promise<{
	operation: "generations" | "edits";
	body: Record<string, unknown>;
}> {
	const paths = args.referenced_image_paths ?? [];
	const background =
		args.transparent_background === true ? "transparent" : "opaque";
	if (paths.length > MAX_EDIT_IMAGES)
		throw new Error(
			"referenced_image_paths must contain at most " +
				MAX_EDIT_IMAGES +
				" paths",
		);
	if (paths.length > 0 && args.num_last_images_to_include != null)
		throw new Error(
			"provide only one of referenced_image_paths or num_last_images_to_include",
		);
	if (paths.length === 0 && args.num_last_images_to_include == null) {
		return {
			operation: "generations",
			body: {
				prompt: args.prompt,
				model,
				background,
				quality: "auto",
				size: "auto",
			},
		};
	}
	const images =
		paths.length > 0
			? await Promise.all(
					paths.map(async (path) => ({
						image_url: await localImageDataUrl(path, env, context),
					})),
				)
			: (recentImages ?? []).map((image) => ({
					image_url: recentImageDataUrl(image),
				}));
	return {
		operation: "edits",
		body: {
			images,
			prompt: args.prompt,
			model,
			background,
			quality: "auto",
			size: "auto",
		},
	};
}
