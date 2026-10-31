import type {
	ComponentInstance,
	ComponentRequest,
} from "@howaboua/pi-durable-components";
import { ApplyPatch } from "./index.ts";

export function createComponent(
	_request: ComponentRequest,
): ComponentInstance<typeof ApplyPatch> {
	return { extensions: [ApplyPatch], api: ApplyPatch, retention: "idle" };
}
