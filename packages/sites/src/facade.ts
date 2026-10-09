// Adapted from pi-chatgpt-sites at 69f50cf70e8a7b05c2349be6227f521b6504f80e.
// Copyright (c) 2026 pasky and Igor Warzocha. MIT licensed.
// Modified for Durable-native registration and explicit execution capabilities.
import type { Context } from "@earendil-works/chord";
import type { JsonSchema, SitesClient } from "./client.ts";
import type { SitesProjectCapability } from "./local-project.ts";
import type { ResolvedOperation } from "./operations.ts";
import { facadeError, resolveOperation } from "./operations.ts";
import { redact } from "./redact.ts";

export async function call(
	request: unknown,
	client: Pick<SitesClient, "schema" | "call">,
	cwd: string,
	projectCapability: SitesProjectCapability,
	context: Context,
) {
	if (!isRecord(request)) {
		throw facadeError(
			"invalid_request",
			"sites expects one JSON object",
			"index",
		);
	}
	const operation = resolveOperation(request["resource"], request["action"]);
	const params = request["params"] === undefined ? {} : request["params"];
	if (!isRecord(params)) {
		throw facadeError(
			"invalid_params",
			"params must be an object",
			operation.topic,
		);
	}
	rejectKeys(
		params,
		["publish_on_push"],
		"publish_on_push is not supported; use explicit save/deploy",
	);

	const prepared = await prepare(
		operation,
		{ ...params },
		client,
		cwd,
		projectCapability,
		context,
	);
	try {
		validateAgainstSchema(
			prepared.args,
			await client.schema(prepared.tool),
			prepared.allowedExtra,
		);
		const raw = await client.call(prepared.tool, prepared.args);
		const completed = await prepared.after(raw);
		return {
			ok: true,
			operation: operation.key,
			result: redact(selectResult(operation, completed)),
		};
	} finally {
		await prepared.cleanup();
	}
}

async function prepare(
	operation: ResolvedOperation,
	params: Record<string, unknown>,
	client: Pick<SitesClient, "schema" | "call">,
	cwd: string,
	capability: SitesProjectCapability,
	context: Context,
) {
	const project = await capability.projectContext(
		params["project_dir"],
		cwd,
		context,
	);
	delete params["project_dir"];
	let tool = operation.tool;
	let after = async (value: unknown) => value;
	let cleanup = async () => {};
	const allowedExtra: string[] = [];

	if (operation.local === "create") {
		cleanup = await capability.acquireHostingLock(project, context);
		try {
			const manifest = await capability.readHosting(project, context);
			if (manifest["project_id"]) {
				throw facadeError(
					"site_already_linked",
					".openai/hosting.json already has project_id; reuse that site",
					"site",
				);
			}
		} catch (error) {
			await cleanup();
			throw error;
		}
		after = async (value: unknown) => {
			const projectId = recordResult(value)?.["id"];
			if (typeof projectId !== "string" || !projectId) {
				throw new Error("Sites created a site but returned no project ID");
			}
			try {
				await capability.persistProjectId(project, projectId, context);
			} catch (error) {
				throw facadeError(
					"manifest_persist_failed",
					`Site was created as ${projectId}, but ${project.manifestPath} could not be updated: ${error instanceof Error ? error.message : String(error)}`,
					"site",
					{ project_id: projectId, manifest_path: project.manifestPath },
				);
			}
			return value;
		};
	} else if (operation.local === "save") {
		rejectKeys(
			params,
			["commit_sha", "archive"],
			"Source save derives commit_sha and does not accept archives",
		);
		const manifest = await capability.readHosting(project, context);
		if (typeof manifest["project_id"] !== "string" || !manifest["project_id"]) {
			throw facadeError(
				"unbound_repository",
				"Source save requires project_id in the repository's .openai/hosting.json",
				"version",
			);
		}
		params["project_id"] = await capability.resolveProjectId(
			params,
			project,
			context,
		);
		const { root, commitSha } = await capability.inspectCleanCommit(
			project,
			context,
		);
		params["commit_sha"] = commitSha;
		// Reject invalid inputs before a source push. Both save routes share this owner.
		validateAgainstSchema(params, await client.schema(tool));
		const credentialResponse = await client.call(
			"create_source_repository_write_credential",
			{
				project_id: params["project_id"],
			},
		);
		const credential = unwrapResult(credentialResponse);
		if (recordResult(credential)?.["publish_on_push_accepted"] === true) {
			throw facadeError(
				"automatic_publication_unsupported",
				"Sites returned an auto-publishing credential; source was not pushed",
				"version",
			);
		}
		await capability.pushCommit({ root, commitSha, credential }, context);
	} else {
		const schema = await client.schema(tool);
		if (schema?.properties?.["project_id"] && !params["project_id"]) {
			params["project_id"] = await capability.resolveProjectId(
				params,
				project,
				context,
			);
		}
	}

	if (operation.local === "deploy") {
		const visibility = params["visibility"];
		if (visibility !== "private" && visibility !== "shared") {
			throw facadeError(
				"visibility_required",
				'deployment.deploy requires params.visibility as "private" or "shared"',
				"deployment",
			);
		}
		tool =
			visibility === "private"
				? "deploy_private_site_version"
				: "deploy_site_version";
		delete params["visibility"];
	}

	if (operation.tool === "list_sites" && params["limit"] === undefined)
		params["limit"] = 20;
	if (operation.tool === "list_site_versions" && params["limit"] === undefined)
		params["limit"] = 20;
	return { tool, args: params, after, cleanup, allowedExtra };
}

function rejectKeys(
	params: Record<string, unknown>,
	keys: string[],
	message: string,
) {
	if (keys.some((key) => key in params)) throw new Error(message);
}

function validateAgainstSchema(
	params: Record<string, unknown>,
	schema: JsonSchema | undefined,
	allowedExtra: string[] = [],
) {
	const properties = schema?.properties ?? {};
	const unknown = Object.keys(params).filter(
		(key) => !Object.hasOwn(properties, key) && !allowedExtra.includes(key),
	);
	if (unknown.length > 0) {
		throw new Error(
			`Unknown parameter${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`,
		);
	}
	const missing = (schema?.required ?? []).filter(
		(key) => params[key] === undefined,
	);
	if (missing.length > 0) {
		throw new Error(
			`Missing required parameter${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`,
		);
	}
}

function selectResult(operation: ResolvedOperation, value: unknown) {
	if (operation.select !== "access") return value;
	const site = recordResult(value);
	return {
		result: {
			id: site?.["id"],
			title: site?.["title"],
			current_live_url: site?.["current_live_url"],
			access_mode: site?.["access_mode"],
			access_policy: site?.["access_policy"],
			available_access_modes: site?.["available_access_modes"],
		},
	};
}

function unwrapResult(value: unknown): unknown {
	return isRecord(value) ? (value["result"] ?? value) : value;
}
function recordResult(value: unknown): Record<string, unknown> | undefined {
	const result = unwrapResult(value);
	return isRecord(result) ? result : undefined;
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
