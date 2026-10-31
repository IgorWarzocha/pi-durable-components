import {
	type ComponentInstance,
	type ComponentRequest,
	defineCapability,
	isCapabilityObject,
} from "@howaboua/pi-durable-components";
import { createBoard } from "./index.ts";

type BoardOptions = NonNullable<Parameters<typeof createBoard>[0]>;

export const boardOptions = defineCapability<BoardOptions>(
	"howaboua.board.options.v1",
	(value): value is BoardOptions => {
		if (!isCapabilityObject(value)) return false;
		const summary = value["summary"];
		if (summary === undefined || summary === false) return true;
		if (!isCapabilityObject(summary)) return false;
		const model = summary["model"];
		const reasoning = summary["reasoning"];
		return (
			(model === undefined ||
				(isCapabilityObject(model) &&
					typeof model["provider"] === "string" &&
					typeof model["modelId"] === "string")) &&
			(reasoning === undefined ||
				(typeof reasoning === "string" &&
					["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
						reasoning,
					)))
		);
	},
);

export function createComponent(
	request: ComponentRequest,
): ComponentInstance<ReturnType<typeof createBoard>> {
	const api = createBoard(
		request.capabilities.has(boardOptions.id)
			? request.capabilities.get(boardOptions)
			: boardOptions.parse(request.configuration),
	);
	let release: (() => void) | undefined;
	return {
		extensions: [api.extension],
		api,
		retention: "harness",
		bind({ harness, storage }) {
			api.bind(harness, storage);
			release = () => api.unbind(harness);
		},
		afterClose() {
			release?.();
			release = undefined;
		},
	};
}
