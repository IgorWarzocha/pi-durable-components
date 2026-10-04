import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { type ExecutionEnv, getOrThrow } from "@earendil-works/pi-durable/env";
import type { ImageResponse } from "./contract.ts";
import type { ImagegenOutput, SavedImage } from "./output.ts";

async function workspaceRoot(
	env: ExecutionEnv,
	context: Context,
): Promise<string> {
	const cwd = getOrThrow(await env.absolutePath(env.cwd, context));
	let current = cwd;
	while (true) {
		const git = getOrThrow(await env.joinPath([current, ".git"], context));
		if (getOrThrow(await env.exists(git, context))) return current;
		const parent = getOrThrow(
			await env.absolutePath(
				getOrThrow(await env.joinPath([current, ".."], context)),
				context,
			),
		);
		if (parent === current) return cwd;
		current = parent;
	}
}

function decodeBase64Image(value: string): Uint8Array {
	const normalized = value.trim();
	if (normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized))
		throw new Error("image generation returned invalid base64 data");
	const bytes = Buffer.from(normalized, "base64");
	if (!bytes.length)
		throw new Error("image generation returned empty image data");
	return bytes;
}

export async function saveGeneratedImages(
	env: ExecutionEnv,
	context: Context,
	response: ImageResponse,
	requestId: string | undefined,
) {
	const root = await workspaceRoot(env, context);
	const directory = getOrThrow(
		await env.joinPath([root, ".pi", "openai-codex-images"], context),
	);
	getOrThrow(await env.createDir(directory, { recursive: true }, context));
	const latest = getOrThrow(
		await env.joinPath([directory, "latest.png"], context),
	);
	const images: SavedImage[] = [];
	const content: Array<{ type: "image"; mimeType: string; data: string }> = [];
	for (const [index, item] of response.data.entries()) {
		const bytes = decodeBase64Image(item.b64_json);
		const suffix = randomUUID().replaceAll("-", "");
		const name = "ig_" + suffix + (index ? "_" + (index + 1) : "") + ".png";
		const path = getOrThrow(await env.joinPath([directory, name], context));
		getOrThrow(await env.writeFile(path, bytes, context));
		if (!index) getOrThrow(await env.writeFile(latest, bytes, context));
		images.push({
			path: ".pi/openai-codex-images/" + name,
			absolute_path: path,
			latest_path: ".pi/openai-codex-images/latest.png",
			latest_absolute_path: latest,
		});
		content.push({
			type: "image",
			mimeType: "image/png",
			data: Buffer.from(bytes).toString("base64"),
		});
	}
	const first = images[0];
	if (!first) throw new Error("image generation returned no image data");
	const output: ImagegenOutput = {
		path: first.path,
		latest_path: first.latest_path,
		images,
		...(response.background !== undefined
			? { background: response.background }
			: {}),
		...(response.background === "transparent"
			? { transparent_background: true }
			: response.background === "opaque"
				? { transparent_background: false }
				: {}),
		...(response.quality !== undefined ? { quality: response.quality } : {}),
		...(response.size !== undefined ? { size: response.size } : {}),
		...(requestId ? { imagegen_request_id: requestId } : {}),
		...(response.usage !== undefined ? { usage: response.usage } : {}),
	};
	return { output, content };
}
