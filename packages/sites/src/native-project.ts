// Adapted from pi-chatgpt-sites at 69f50cf70e8a7b05c2349be6227f521b6504f80e.
// Copyright (c) 2026 pasky and Igor Warzocha. MIT licensed.
// Modified for Durable-native registration and explicit execution capabilities.

import {
	type FileHandle,
	mkdir,
	open,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { SitesProjectCapability } from "./local-project.ts";

import { gitForContext, pushCommit, type RunGit } from "./native-git.ts";

/** Explicit native capability. Never construct this for a remote or container namespace. */
export function createNativeSitesProjectCapability(
	environment: NodeExecutionEnv,
): SitesProjectCapability {
	if (
		!(environment instanceof NodeExecutionEnv) ||
		environment.id !== "node:local"
	)
		throw new Error("Native Sites requires the local Node execution namespace");
	return {
		id: environment.id,
		projectContext: (directory, cwd, context) => {
			context.abortSignal?.throwIfAborted();
			return projectContext(
				directory,
				cwd,
				gitForContext(environment, context),
				context.abortSignal,
			);
		},
		acquireHostingLock: async (project, context) => {
			context.abortSignal?.throwIfAborted();
			return acquireHostingLock(project);
		},
		readHosting: async (project, context) => {
			context.abortSignal?.throwIfAborted();
			return readHosting(project);
		},
		persistProjectId: async (project, id, context) => {
			context.abortSignal?.throwIfAborted();
			return persistProjectId(project, id);
		},
		resolveProjectId: async (params, project, context) => {
			context.abortSignal?.throwIfAborted();
			return resolveProjectId(params, project);
		},
		inspectCleanCommit: (project, context) =>
			inspectCleanCommit(
				project,
				gitForContext(environment, context),
				context.abortSignal,
			),
		pushCommit: (request, context) =>
			pushCommit({
				...request,
				git: gitForContext(environment, context),
				signal: context.abortSignal,
			}),
	};
}

interface ProjectContext {
	root: string;
	manifestPath: string;
}
async function projectContext(
	projectDir: unknown,
	cwd: string,
	git: RunGit,
	signal?: AbortSignal,
): Promise<ProjectContext> {
	if (projectDir && typeof projectDir !== "string")
		throw new Error("project_dir must name a directory");
	const requested =
		typeof projectDir === "string" && projectDir
			? resolve(cwd, projectDir)
			: cwd;
	const requestedStat = await stat(requested);
	if (!requestedStat.isDirectory())
		throw new Error("project_dir must name a directory");
	let gitRoot;
	try {
		gitRoot = (
			await git(
				requested,
				["rev-parse", "--show-toplevel"],
				process.env,
				signal,
			)
		).trim();
	} catch {
		signal?.throwIfAborted();
		// Site creation can precede Git initialization.
	}
	if (projectDir && gitRoot && resolve(gitRoot) !== requested) {
		throw new Error(
			"project_dir must be the Git repository root, not a nested directory",
		);
	}
	const root = gitRoot || requested;
	return { root, manifestPath: join(root, ".openai", "hosting.json") };
}

async function acquireHostingLock(context: ProjectContext) {
	await mkdir(dirname(context.manifestPath), { recursive: true });
	const lockPath = join(dirname(context.manifestPath), "hosting.lock");
	let handle: FileHandle | undefined;
	try {
		handle = await open(lockPath, "wx", 0o600);
		await handle.writeFile(`${process.pid}\n`);
	} catch (error) {
		if (handle) {
			try {
				await handle.close();
			} finally {
				await rm(lockPath, { force: true });
			}
		}
		if (error instanceof Error && "code" in error && error.code === "EEXIST") {
			throw new Error(`Another Sites operation holds ${lockPath}`);
		}
		throw error;
	}
	const acquired = handle;
	let released = false;
	return async () => {
		if (released) return;
		released = true;
		try {
			await acquired.close();
		} finally {
			await rm(lockPath, { force: true });
		}
	};
}

async function readHosting(
	context: ProjectContext,
): Promise<Record<string, unknown>> {
	try {
		const value: unknown = JSON.parse(
			await readFile(context.manifestPath, "utf8"),
		);
		if (!isRecord(value)) {
			throw new Error("manifest must contain a JSON object");
		}
		return value;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return {};
		throw new Error(
			`${context.manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function persistProjectId(context: ProjectContext, projectId: string) {
	const manifest = await readHosting(context);
	if (manifest["project_id"] && manifest["project_id"] !== projectId) {
		throw new Error(
			`${context.manifestPath} already contains a different project_id`,
		);
	}
	manifest["project_id"] = projectId;
	await mkdir(dirname(context.manifestPath), { recursive: true });
	const temporary = `${context.manifestPath}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {
		mode: 0o600,
	});
	await rename(temporary, context.manifestPath);
}

async function resolveProjectId(
	params: Record<string, unknown>,
	context: ProjectContext,
) {
	const manifest = await readHosting(context);
	const supplied = params["project_id"];
	if (supplied !== undefined && typeof supplied !== "string") {
		throw new Error("project_id must be a string");
	}
	if (
		supplied &&
		manifest["project_id"] &&
		supplied !== manifest["project_id"]
	) {
		throw new Error("project_id does not match .openai/hosting.json");
	}
	const projectId = supplied || manifest["project_id"];
	if (!projectId) {
		throw new Error("No project_id supplied and .openai/hosting.json has none");
	}
	return projectId;
}

async function inspectCleanCommit(
	context: ProjectContext,
	git: RunGit,
	signal?: AbortSignal,
) {
	const root = (
		await git(
			context.root,
			["rev-parse", "--show-toplevel"],
			process.env,
			signal,
		)
	).trim();
	const status = await git(
		root,
		["status", "--porcelain=v1", "--untracked-files=all"],
		process.env,
		signal,
	);
	if (status.trim())
		throw new Error("Source save requires a clean Git worktree");
	const manifestRelative = ".openai/hosting.json";
	await git(
		root,
		["ls-files", "--error-unmatch", manifestRelative],
		process.env,
		signal,
	);
	const commitSha = (
		await git(root, ["rev-parse", "HEAD"], process.env, signal)
	).trim();
	if (!/^[0-9a-f]{40,64}$/i.test(commitSha))
		throw new Error("Could not resolve the current Git commit");
	return { root, commitSha };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
