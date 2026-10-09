// Adapted from pi-chatgpt-sites at 69f50cf70e8a7b05c2349be6227f521b6504f80e.
// Copyright (c) 2026 pasky and Igor Warzocha. MIT licensed.
// Modified for Durable-native registration and explicit execution capabilities.
import type { JsonSchema, SitesClient } from "./client.ts";
import { guides } from "./docs.ts";
import { operationForTopic, type ResolvedOperation } from "./operations.ts";

export async function documentation(
	input = "index",
	client: Pick<SitesClient, "schema">,
) {
	const requested = input.trim() || "index";
	const topic = requested.replace(/^['"]|['"]$/g, "");
	const operation = operationForTopic(topic);
	if (operation) {
		const guide = await readTopic(operation.topic);
		const schemas =
			operation.local === "deploy"
				? {
						private: documentationSchema(
							await client.schema("deploy_private_site_version"),
							operation,
						),
						shared: documentationSchema(
							await client.schema("deploy_site_version"),
							operation,
						),
					}
				: documentationSchema(await client.schema(operation.tool), operation);
		return boundedDocumentation(
			`${guide}\n\n## Current params schema for ${operation.key}\n\n` +
				`${operationSchemaNote(operation)}\n\n\`\`\`json\n${JSON.stringify(schemas, null, 2)}\n\`\`\`\n`,
		);
	}
	const known = new Set([
		"index",
		"workflow",
		"site",
		"version",
		"deployment",
		"access",
		"environment",
		"domains",
		"analytics",
		"mcp",
		"building",
		"diagnostics",
		"database",
		"schedules",
	]);
	return readTopic(known.has(topic) ? topic : "index");
}

function operationSchemaNote(operation: ResolvedOperation) {
	if (operation.local === "save") {
		return "The facade derives and pushes `commit_sha`; archives are unsupported. `project_dir` selects the clean bound repository.";
	}
	if (operation.local === "deploy") {
		return 'The facade additionally requires `visibility: "private" | "shared"`; this facade field is stripped before the backend call.';
	}
	return "Pass the backend fields inside `params`. `project_id` may be omitted when `.openai/hosting.json` supplies it.";
}

function documentationSchema(
	schema: JsonSchema | undefined,
	operation: ResolvedOperation,
) {
	const projected: JsonSchema = JSON.parse(
		JSON.stringify(schema, (key, value) =>
			(key === "description" || key === "title") && typeof value === "string"
				? undefined
				: value,
		),
	);
	const blocked = [
		"publish_on_push",
		...(operation.local === "save" ? ["commit_sha", "archive"] : []),
	];
	for (const key of blocked) delete projected.properties?.[key];
	if (projected.required)
		projected.required = projected.required.filter(
			(key) => !blocked.includes(key),
		);
	return projected;
}

async function readTopic(topic: string) {
	const text = guides[topic];
	if (text === undefined) throw new Error("Unknown Sites documentation topic");
	return boundedDocumentation(text);
}

function boundedDocumentation(text: string) {
	const max = 16_000;
	if (Buffer.byteLength(text) <= max) return text;
	const suffix = "\n\n[Documentation truncated; request the narrower topic.]\n";
	const budget = max - Buffer.byteLength(suffix);
	let prefix = Buffer.from(text).subarray(0, budget).toString("utf8");
	while (Buffer.byteLength(prefix) > budget) prefix = prefix.slice(0, -1);
	return `${prefix}${suffix}`;
}
