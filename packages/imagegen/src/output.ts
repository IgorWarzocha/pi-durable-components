import type { JsonValue } from "@earendil-works/chord";

export interface SavedImage {
	path: string;
	absolute_path: string;
	latest_path: string;
	latest_absolute_path: string;
}
export type ImagegenOutput = {
	path: string;
	latest_path: string;
	images: SavedImage[];
	background?: string | null;
	transparent_background?: boolean;
	quality?: string | null;
	size?: string | null;
	imagegen_request_id?: string;
	usage?: JsonValue;
};

export function formatImagegenOutput(output: ImagegenOutput): string {
	return `Generated image: ${output.path}\nLatest: ${output.latest_path}`;
}
