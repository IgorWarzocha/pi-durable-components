import type { JsonValue } from "@earendil-works/chord";
import { Type } from "typebox";

export const IMAGE_GENERATION_TOOL_NAME = "imagegen";
export const IMAGE_GENERATION_UNSUPPORTED_MESSAGE =
	"imagegen requires an image-capable OpenAI Codex-compatible Responses provider";
export const IMAGE_MODEL = "gpt-image-2.5";
export const MAX_EDIT_IMAGES = 5;

export const IMAGE_GENERATION_PARAMETERS = Type.Object(
	{
		prompt: Type.String({
			description: "Include target aspect ratio and quality",
		}),
		transparent_background: Type.Optional(
			Type.Boolean({
				description:
					"True for transparency or cutouts; for edits preserve existing transparency unless asked to change it",
			}),
		),
		referenced_image_paths: Type.Optional(
			Type.Union([
				Type.Array(Type.String(), {
					description: "Local edit targets",
					maxItems: MAX_EDIT_IMAGES,
				}),
				Type.Null(),
			]),
		),
		num_last_images_to_include: Type.Optional(
			Type.Union([
				Type.Integer({
					description: "Smallest recent edit count",
					minimum: 1,
					maximum: MAX_EDIT_IMAGES,
				}),
				Type.Null(),
			]),
		),
	},
	{ additionalProperties: false },
);

export interface ImagegenArgs {
	prompt: string;
	transparent_background?: boolean;
	referenced_image_paths?: string[] | null;
	num_last_images_to_include?: number | null;
}

export interface ImageResponse {
	data: Array<{ b64_json: string }>;
	background?: string | null;
	quality?: string | null;
	size?: string | null;
	usage?: JsonValue;
}
