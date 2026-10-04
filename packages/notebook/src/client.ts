// Adapted from pi-codex-conversion at b2006db9def12c373ae48e70044d30f7d6b7e34f, MIT. See ../NOTICE.

import { NotebookExecutionRuntime } from "./execution-runtime.ts";
import { NotebookLifecycleController } from "./lifecycle.ts";
import {
	projectStateBindingSelection,
	promoteProjectStateBindings,
	syncProjectStateBindings,
} from "./project-state.ts";
import type { ProjectStatePinUpdate } from "./project-state-merge.ts";
import { NotebookRecoveryController } from "./recovery.ts";
import type {
	NotebookControlRequest,
	NotebookControlResult,
	NotebookExecutionClient,
	NotebookRuntimeOptions,
	NotebookToolDefinition,
	RuntimeResponse,
	ToolExecutionContext,
} from "./runtime-contract.ts";
import { NotebookSessionRuntime } from "./session-runtime.ts";

export class NotebookClient implements NotebookExecutionClient {
	private readonly execution: NotebookExecutionRuntime;
	private readonly session: NotebookSessionRuntime;
	private readonly lifecycle: NotebookLifecycleController;
	private readonly recovery: NotebookRecoveryController;

	constructor(options: NotebookRuntimeOptions) {
		let session!: NotebookSessionRuntime;
		this.execution = new NotebookExecutionRuntime(
			() => session,
			(context, signal) => this.prepareSession(context, signal),
		);
		this.session = session = new NotebookSessionRuntime({
			runtime: options,
			bridge: this.execution.bridge,
			runningCellId: () => this.execution.runningCellId(),
		});
		this.recovery = new NotebookRecoveryController(
			{
				agentDir: options.agentDir,
				maxBytes: session.checkpointMaxBytes,
				profile: options.profile,
			},
			{
				stopWithoutCheckpoint: () => this.stopWithoutCheckpoint(),
				startClean: async (context, signal) => {
					await session.restart(context, signal, true);
				},
				checkpointEmpty: () =>
					session.checkpoints.flush({ force: true, requireIdle: true }),
				configuredProfileActive: () => session.configuredProfileLoaded(),
				runtimeHealth: (context) => session.runtimeHealthFor(context),
			},
		);
		this.lifecycle = new NotebookLifecycleController({
			prepare: (context, signal) => this.prepareSession(context, signal),
			diagnostics: (context, signal) =>
				this.recovery.diagnostics(context, signal),
			reset: (context, signal) => this.recovery.reset(context, signal),
			unpinWithoutStartup: (names, context, signal) =>
				this.recovery.unpin(names, context, signal),
			kernel: () => session.kernel(),
			activeCellId: () => this.execution.activeCellId(),
			stopActive: () => this.execution.stopActive(),
			checkpoint: (excludeNames, pins) => this.checkpoint(excludeNames, pins),
			retainedBindings: () => session.retainedBindings(),
			promoteBindings: async (names) => {
				const kernel = session.kernel();
				if (!kernel) throw new Error("Notebook kernel is unavailable");
				const previous = await projectStateBindingSelection(kernel);
				try {
					await promoteProjectStateBindings(kernel, names);
				} catch (error) {
					await syncProjectStateBindings(kernel, previous).catch(
						() => undefined,
					);
					throw error;
				}
				return () => syncProjectStateBindings(kernel, previous);
			},
			markChanged: () => session.checkpoints.schedule(),
			restart: (context, signal) => session.restart(context, signal),
			rollback: async (context) => {
				await session.restart(context, undefined, true);
			},
			baselineNames: () => session.baselineNames(),
			profileStorage: () => ({
				agentDir: options.agentDir,
				maxBytes: session.checkpointMaxBytes,
			}),
			metadata: () => session.metadata(),
			runtimeHealth: () => session.runtimeHealth(),
		});
	}

	execute(
		source: string,
		context: ToolExecutionContext,
		signal?: AbortSignal,
		tools: NotebookToolDefinition[] = [],
	): Promise<RuntimeResponse> {
		return this.execution.execute(source, context, signal, tools);
	}

	wait(
		cellId: string,
		yieldTimeMs: number,
		context: ToolExecutionContext,
		signal?: AbortSignal,
	): Promise<RuntimeResponse> {
		return this.execution.wait(cellId, yieldTimeMs, context, signal);
	}

	terminate(
		cellId: string,
		context: ToolExecutionContext,
		signal?: AbortSignal,
	): Promise<RuntimeResponse> {
		return this.execution.terminate(cellId, context, signal);
	}

	async checkpoint(
		excludeNames?: ReadonlySet<string>,
		pins?: ProjectStatePinUpdate,
	): Promise<void> {
		try {
			await this.session.checkpoints.flush({
				requireIdle: true,
				force: true,
				excludeNames,
				pins,
			});
		} catch (error) {
			await this.session.recoverFromBootstrapFailure(error);
			throw error;
		}
		try {
			this.session.materializeJournal();
		} catch (error) {
			if (!pins) throw error;
			this.session.addNotice(
				`Notebook journal was not materialized: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	async controlNotebook(
		request: NotebookControlRequest,
		context: ToolExecutionContext,
		signal?: AbortSignal,
	): Promise<NotebookControlResult> {
		let result: NotebookControlResult;
		try {
			result = await this.lifecycle.control(request, context, signal);
		} catch (error) {
			await this.session.recoverFromBootstrapFailure(error);
			throw error;
		}
		const notice = this.session.takeNotice();
		return notice
			? {
					message: `${notice}\n${result.message}`,
					details: { ...result.details, startupNotice: notice },
				}
			: result;
	}

	async shutdown(): Promise<void> {
		await this.session.abortStartup(
			new Error("Notebook session is shutting down"),
		);
		await this.execution.stopActive().catch(() => undefined);
		await this.session.checkpoints
			.flush({ force: true })
			.catch(() => undefined);
		try {
			this.session.materializeJournal();
		} catch {}
		await this.lifecycle
			.disposeAll(AbortSignal.timeout(1_500))
			.catch(() => undefined);
		this.execution.clear();
		await this.session.shutdown();
	}

	private async prepareSession(
		context: ToolExecutionContext,
		signal?: AbortSignal,
	): Promise<void> {
		const extension = context.sessionContext;
		if (!extension)
			throw new Error("Notebook requires a notebook session context");
		if (!this.session.identityMatches(extension)) await this.shutdown();
		await this.session.ensure(context, signal);
	}

	private async stopWithoutCheckpoint(): Promise<string | undefined> {
		const activeCell = await this.execution.stopActive();
		this.execution.clear();
		await this.session.stopWithoutCheckpoint();
		return activeCell;
	}
}
