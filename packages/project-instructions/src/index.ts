import type { Context, JsonValue } from "@earendil-works/chord";
import {
	defineDoc,
	defineExtension,
	section,
	type ToolExecutionApi,
	type Wrap,
} from "@earendil-works/pi-durable";
import { type ExecutionEnv, getOrThrow } from "@earendil-works/pi-durable/env";

const Scopes = defineDoc<{ environments: Record<string, string[]> }>({
	kind: "howaboua.project-instructions.scopes",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	checkpointWhen: () => true,
	initial: () => ({ environments: {} }),
});

function savedScopes(
	state: { environments: Record<string, string[]> } | undefined,
	id: string,
) {
	return state?.environments[`env:${id}`] ?? [];
}

async function ancestors(
	env: ExecutionEnv,
	directory: string,
	context: Context,
) {
	const paths: string[] = [];
	let current = getOrThrow(await env.absolutePath(directory, context));
	while (true) {
		paths.push(current);
		const parent = getOrThrow(await env.joinPath([current, ".."], context));
		if (parent === current) return paths.reverse();
		current = parent;
	}
}

function object(value: JsonValue | undefined) {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value
		: undefined;
}

function targets(name: string, args: unknown, details?: JsonValue): string[] {
	if (name !== "apply_patch")
		return args !== null &&
			typeof args === "object" &&
			"path" in args &&
			typeof args.path === "string"
			? [args.path]
			: [];
	const changed = object(object(details)?.["result"])?.["changedFiles"];
	return Array.isArray(changed)
		? changed.filter((path): path is string => typeof path === "string")
		: [];
}

async function remember(
	paths: string[],
	api: ToolExecutionApi,
	context: Context,
) {
	const env = api.env;
	if (!env || paths.length === 0) return;
	const baseline = new Set(await ancestors(env, env.cwd, context));
	const directories = new Set<string>();
	for (const path of paths) {
		const absolute = getOrThrow(await env.absolutePath(path, context));
		const parent = getOrThrow(await env.joinPath([absolute, ".."], context));
		for (const directory of await ancestors(env, parent, context)) {
			if (!baseline.has(directory)) directories.add(directory);
		}
	}
	if (!directories.size) return;
	const snapshot = await api.snapshot(Scopes, api.conversationId, context);
	if (
		[...directories].every((path) =>
			savedScopes(snapshot, env.id).includes(path),
		)
	)
		return;
	await api.commit(async (tx) => {
		const state = await tx.doc(Scopes, api.conversationId);
		state.environments[`env:${env.id}`] = [
			...new Set([...savedScopes(state, env.id), ...directories]),
		].sort();
	}, context);
}

/** Read scoped project guidance in the conversation's execution environment. */
export function createProjectInstructions(
	options: { fileNames?: readonly string[] } = {},
) {
	const names = [...new Set(options.fileNames ?? ["AGENTS.md"])];
	if (
		!names.length ||
		names.some(
			(name) => !name || name === "." || name === ".." || /[/\\\0]/.test(name),
		)
	) {
		throw new Error("fileNames must contain plain file names");
	}
	const wraps: Wrap[] = ["read", "write", "edit", "apply_patch"].map(
		(name): Extract<Wrap, { tool: string }> => ({
			tool: name,
			wrap: (tool) => ({
				...tool,
				async execute(args, api, context) {
					const result = await tool.execute(args, api, context);
					try {
						await remember(targets(name, args, result.details), api, context);
					} catch (error) {
						// A completed file operation must never become a retryable failure.
						api.diagnostic({
							severity: "warn",
							code: "project-instructions",
							message: `Project instruction discovery failed: ${String(error)}`,
						});
					}
					return result;
				},
			}),
		}),
	);
	return defineExtension({
		name: "howaboua.project-instructions",
		wraps,
		sections: [
			section("project-instructions", async (input, context) => {
				const env = input.env;
				if (!env) return undefined;
				const state = await input.read.snapshot(
					Scopes,
					input.conversationId,
					context,
				);
				const directories = new Set(await ancestors(env, env.cwd, context));
				for (const directory of savedScopes(state, env.id))
					directories.add(directory);
				const chunks: string[] = [];
				for (const directory of directories) {
					for (const name of names) {
						const path = getOrThrow(
							await env.joinPath([directory, name], context),
						);
						const result = await env.readTextFile(path, context);
						if (!result.ok) {
							if (
								result.error.code === "not_found" ||
								result.error.code === "not_directory"
							)
								continue;
							context.abortSignal?.throwIfAborted();
							chunks.push(
								`Could not read project instructions at ${path}: ${result.error.message}`,
							);
							break;
						}
						if (result.value.trim())
							chunks.push(
								`Instructions from ${path} (scope: ${directory} and descendants):\n${result.value}`,
							);
						break;
					}
				}
				return chunks.length ? chunks.join("\n\n") : undefined;
			}),
		],
	});
}
