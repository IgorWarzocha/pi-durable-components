import { isGpt6ModelId } from "./openai-codex/responses-lite-model.ts";

/** Run after replay too: native checkpoints can restore an update at the tail. */
export function normalizeCodexConfigurationUpdates<
	T extends {
		input: unknown[];
		model?: string | undefined;
		[key: string]: unknown;
	},
>(body: T): T {
	const isUpdate = (item: unknown): boolean =>
		Boolean(
			item &&
				typeof item === "object" &&
				"type" in item &&
				item.type === "configuration_update",
		);
	if (!body.input.some(isUpdate)) return body;
	// A model switch is a new lane; native configuration is not portable to older models.
	if (body.model && !isGpt6ModelId(body.model))
		return { ...body, input: body.input.filter((item) => !isUpdate(item)) };
	if (
		body["truncation"] === "auto" ||
		(Array.isArray(body["context_management"]) &&
			body["context_management"].length > 0)
	) {
		throw new Error(
			"GPT-6 reasoning updates cannot use automatic truncation or server automatic compaction; use an explicit compaction_trigger",
		);
	}
	// Multiple selector presses before a response are one effective update.
	// Persisted records stay intact; never append adjacent native updates.
	const input: unknown[] = [];
	for (const item of body.input) {
		if (isUpdate(item) && isUpdate(input.at(-1))) input.pop();
		input.push(item);
	}
	return { ...body, input };
}
