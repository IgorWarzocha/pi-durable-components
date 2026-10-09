import type { TSchema } from "@earendil-works/pi-ai";
export interface GrokToolWireDefinition extends Record<string, unknown> {
	type: "function";
	name: string;
	description: string;
	parameters: TSchema;
}
