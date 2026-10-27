// Adapted from pi-codex-conversion at 84bd5bce, MIT. See ../NOTICE.
import {
	constants,
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { checkpointPaths } from "./checkpoint-store.ts";
import { ensureNotebookDenoBinary } from "./deno-binary.ts";
import { withProfileLock } from "./profile-state.ts";
import {
	assertSafeProfileDirectory,
	profileStatePaths,
} from "./profile-state-format.ts";
import { resolveNotebookProject } from "./project-identity.ts";
import { projectStatePaths } from "./project-state-files.ts";
import { withProjectStateLock } from "./project-state-lock.ts";
import type {
	NotebookRuntimeOptions,
	ToolExecutionContext,
} from "./runtime-contract.ts";
import { notebookSessionIdentity } from "./session-identity.ts";

// Serialize against disk commits, never force a live cell into the fork baseline.
export async function prepareIsolatedNotebookStorage(
	options: NotebookRuntimeOptions,
	context: ToolExecutionContext,
	directory: string,
	readCommitted: (capture: () => Promise<void>) => Promise<void>,
	signal: AbortSignal,
): Promise<void> {
	const project = resolveNotebookProject(context.cwd);
	const original = projectStatePaths(project, options.agentDir);
	mkdirSync(original.directory, { recursive: true });
	await readCommitted(() =>
		withProjectStateLock(
			original.lock,
			async () => {
				copyDirectory(
					original.directory,
					projectStatePaths(project, directory).directory,
				);
				const identity = {
					project,
					session: notebookSessionIdentity(context.sessionContext),
				};
				copyDirectory(
					checkpointPaths({ ...identity, agentDir: options.agentDir })
						.directory,
					checkpointPaths({ ...identity, agentDir: directory }).directory,
				);
			},
			signal,
		),
	);
	const profileName = options.profile;
	if (profileName) {
		const profile = profileStatePaths(profileName, options.agentDir);
		assertSafeProfileDirectory(profile.directory, options.agentDir);
		if (existsSync(profile.directory))
			await withProfileLock(
				profile.lock,
				async () => {
					copyDirectory(
						profile.directory,
						profileStatePaths(profileName, directory).directory,
					);
				},
				signal,
			);
	}
	const binary = await ensureNotebookDenoBinary(
		{ agentDir: options.agentDir },
		signal,
	);
	const destination = join(directory, relative(options.agentDir, binary));
	mkdirSync(dirname(destination), { recursive: true });
	copyFileSync(binary, destination, constants.COPYFILE_FICLONE);
}

function copyDirectory(source: string, destination: string): void {
	if (!existsSync(source)) return;
	cpSync(source, destination, {
		recursive: true,
		filter: (path) => !path.endsWith("write.lock"),
	});
}
