// Adapted from pi-codex-conversion at b2006db9def12c373ae48e70044d30f7d6b7e34f, MIT. See ../NOTICE.

import { type NotebookCheckpointIdentity } from "./checkpoint.ts";
import {
	notebookCheckpointBindingNames,
	removeNotebookCheckpoint,
} from "./checkpoint-store.ts";
import { ensureNotebookDenoBinary } from "./deno-binary.ts";
import { initializeNotebookJournal } from "./journal.ts";
import { formatNameList } from "./lifecycle-result.ts";
import { diagnoseNotebook } from "./notebook-diagnostics.ts";
import { notebookProfileBindingNames } from "./profile-state.ts";
import { resolveNotebookProject } from "./project-identity.ts";
import { unpinProjectStateBindings } from "./project-state-commit.ts";
import {
	projectStateBindingNames,
	readRetainedProjectBindings,
} from "./project-state-metadata.ts";
import type {
	NotebookControlResult,
	NotebookSessionContext,
	ToolExecutionContext,
} from "./runtime-contract.ts";
import type { NotebookRuntimeHealth } from "./runtime-health.ts";
import { notebookSessionIdentity } from "./session-identity.ts";

interface NotebookRecoveryHost {
	stopWithoutCheckpoint(): Promise<string | undefined>;
	startClean(
		context: NotebookSessionContext,
		signal?: AbortSignal,
	): Promise<void>;
	checkpointEmpty(): Promise<void>;
	configuredProfileActive(): boolean;
	runtimeHealth(context: NotebookSessionContext): NotebookRuntimeHealth;
}

export class NotebookRecoveryController {
	private readonly agentDir: string;
	private readonly maxBytes: number;
	private readonly profile: string | undefined;
	private readonly host: NotebookRecoveryHost;

	constructor(
		options: {
			agentDir: string;
			maxBytes: number;
			profile?: string | undefined;
		},
		host: NotebookRecoveryHost,
	) {
		this.agentDir = options.agentDir;
		this.maxBytes = options.maxBytes;
		this.profile = options.profile;
		this.host = host;
	}

	async diagnostics(
		context: ToolExecutionContext,
		signal?: AbortSignal,
	): Promise<NotebookControlResult> {
		const identity = this.identity(context, "diagnostics");
		const journal = initializeNotebookJournal(identity, this.maxBytes);
		const deno = await ensureNotebookDenoBinary(
			{ agentDir: this.agentDir },
			signal,
		);
		const runtimeBindings = new Set([
			...projectStateBindingNames(identity, this.maxBytes),
			...notebookCheckpointBindingNames(identity, this.maxBytes),
			...(this.host.configuredProfileActive()
				? notebookProfileBindingNames(
						this.profile,
						this.agentDir,
						this.maxBytes,
					)
				: []),
		]);
		return diagnoseNotebook({
			deno,
			cwd: identity.project,
			path: journal.path,
			runtimeBindings,
			runtimeHealth: this.host.runtimeHealth(
				requireNotebookSessionContext(context, "diagnostics"),
			).state,
			signal,
		});
	}

	async unpin(
		names: string[],
		context: ToolExecutionContext,
		signal?: AbortSignal,
	): Promise<NotebookControlResult> {
		const identity = this.identity(context, "unpin");
		await this.host.stopWithoutCheckpoint();
		await unpinProjectStateBindings(identity, names, signal);
		return {
			message: `Unpinned durable notebook bindings: ${formatNameList(names)}; hooks removed`,
			details: { pinned: false, bindingCount: names.length },
		};
	}

	async reset(
		context: ToolExecutionContext,
		signal?: AbortSignal,
	): Promise<NotebookControlResult> {
		signal?.throwIfAborted();
		const extension = requireNotebookSessionContext(context, "reset");
		const identity = notebookIdentity(extension, this.agentDir);
		const retained = readRetainedProjectBindings(identity, this.maxBytes);
		const pinned = retained.filter(({ pinned: isPinned }) => isPinned).length;
		const activeCell = await this.host.stopWithoutCheckpoint();
		removeNotebookCheckpoint(identity);
		await this.host.startClean(extension, signal);
		await this.host.checkpointEmpty();
		return {
			message: `Notebook reset to durable project state; preserved ${retained.length} project binding${retained.length === 1 ? "" : "s"}${pinned > 0 ? ` including ${pinned} pinned` : ""}${activeCell ? ` and terminated ${activeCell}` : ""}. The session checkpoint was discarded; saved notebook and named profiles were preserved`,
			details: {
				project: identity.project,
				preservedProjectBindings: retained.length,
				preservedPinnedBindings: pinned,
				discardedSessionCheckpoint: true,
				...(activeCell ? { terminatedCell: activeCell } : {}),
			},
		};
	}

	private identity(
		context: ToolExecutionContext,
		action: string,
	): NotebookCheckpointIdentity {
		return notebookIdentity(
			requireNotebookSessionContext(context, action),
			this.agentDir,
		);
	}
}

function notebookIdentity(
	context: NotebookSessionContext,
	agentDir: string,
): NotebookCheckpointIdentity {
	return {
		project: resolveNotebookProject(context.cwd),
		session: notebookSessionIdentity(context),
		agentDir,
	};
}

function requireNotebookSessionContext(
	context: ToolExecutionContext,
	action: string,
): NotebookSessionContext {
	if (!context.sessionContext)
		throw new Error(`Notebook ${action} requires a notebook session context`);
	return context.sessionContext;
}
