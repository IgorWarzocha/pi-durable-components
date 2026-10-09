import type { Context } from "@earendil-works/chord";

export interface ProjectContext {
	root: string;
	manifestPath: string;
}

/** Host-authorized filesystem and Git owner for exactly one execution namespace. */
export interface SitesProjectCapability {
	readonly id: string;
	projectContext(
		projectDir: unknown,
		cwd: string,
		context: Context,
	): Promise<ProjectContext>;
	acquireHostingLock(
		project: ProjectContext,
		context: Context,
	): Promise<() => Promise<void>>;
	readHosting(
		project: ProjectContext,
		context: Context,
	): Promise<Record<string, unknown>>;
	persistProjectId(
		project: ProjectContext,
		projectId: string,
		context: Context,
	): Promise<void>;
	resolveProjectId(
		params: Record<string, unknown>,
		project: ProjectContext,
		context: Context,
	): Promise<unknown>;
	inspectCleanCommit(
		project: ProjectContext,
		context: Context,
	): Promise<{ root: string; commitSha: string }>;
	pushCommit(
		request: { root: string; commitSha: string; credential: unknown },
		context: Context,
	): Promise<void>;
}
