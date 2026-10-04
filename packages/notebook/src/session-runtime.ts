// Adapted from pi-codex-conversion at b2006db9def12c373ae48e70044d30f7d6b7e34f, MIT. See ../NOTICE.

import type { NotebookBridgeServer } from "./bridge-server.ts";
import { resolveNotebookCheckpointMaxBytes } from "./checkpoint.ts";
import type { NotebookCheckpointIdentity } from "./checkpoint-format.ts";
import { NotebookCheckpointManager } from "./checkpoint-manager.ts";
import type { DenoJupyterKernel } from "./jupyter-kernel.ts";
import { resolveNotebookProject } from "./project-identity.ts";
import {
	type RetainedProjectBinding,
	readRetainedProjectBindings,
} from "./project-state-metadata.ts";
import type {
	NotebookRuntimeOptions,
	NotebookSessionContext,
	ToolExecutionContext,
} from "./runtime-contract.ts";
import {
	isNotebookBootstrapFailure,
	NOTEBOOK_BOOTSTRAP_NOTICE,
	NOTEBOOK_INTERRUPTED_NOTICE,
	NOTEBOOK_KERNEL_FAILURE_NOTICE,
	type NotebookRuntimeHealth,
	type NotebookRuntimeHealthState,
} from "./runtime-health.ts";
import { notebookSessionIdentity } from "./session-identity.ts";
import { NotebookSessionObservations } from "./session-observations.ts";
import { startNotebookSession } from "./session-startup.ts";

export class NotebookSessionRuntime {
	readonly options: NotebookRuntimeOptions;
	readonly checkpointMaxBytes: number;
	readonly checkpoints: NotebookCheckpointManager;
	readonly observations: NotebookSessionObservations;
	private readonly bridge: NotebookBridgeServer;
	private readonly runningCellId: () => string | undefined;
	private kernelValue: DenoJupyterKernel | undefined;
	private runtimeHealthValue: NotebookRuntimeHealthState = "not_started";
	private identityValue: string | undefined;
	private checkpointIdentityValue: NotebookCheckpointIdentity | undefined;
	private startup: Promise<void> | undefined;
	private startupAbort: AbortController | undefined;
	private baseline = new Set<string>();
	private profileLoaded = false;

	constructor(options: {
		runtime: NotebookRuntimeOptions;
		bridge: NotebookBridgeServer;
		runningCellId(): string | undefined;
	}) {
		this.options = options.runtime;
		this.bridge = options.bridge;
		this.runningCellId = options.runningCellId;
		this.checkpointMaxBytes = resolveNotebookCheckpointMaxBytes(
			options.runtime.maxHeapMiB,
		);
		this.checkpoints = new NotebookCheckpointManager({
			maxBytes: this.checkpointMaxBytes,
			currentKernel: () => this.kernelValue,
			runningCellId: this.runningCellId,
			reportNotice: (notice) => {
				this.observations.addNotice(notice);
			},
		});
		this.observations = new NotebookSessionObservations(
			() => this.checkpointIdentityValue,
			() => this.checkpoints.status(),
		);
	}

	identityMatches(context: NotebookSessionContext): boolean {
		return (
			!this.identityValue || this.identityValue === sessionIdentity(context)
		);
	}

	async ensure(
		context: ToolExecutionContext,
		signal?: AbortSignal,
	): Promise<void> {
		const extension = context.sessionContext;
		if (!extension)
			throw new Error("Notebook requires a notebook session context");
		if (!this.startup) {
			this.identityValue = sessionIdentity(extension);
			this.beginStartup(extension, signal);
		}
		await this.startup;
	}

	async restart(
		context: NotebookSessionContext,
		signal?: AbortSignal,
		skipProfile = false,
	): Promise<string | undefined> {
		await this.abortStartup(new Error("Notebook kernel is restarting"));
		try {
			this.observations.materializeJournal();
		} catch {}
		const previous = this.kernelValue;
		this.kernelValue = undefined;
		this.runtimeHealthValue = "not_started";
		this.startup = undefined;
		await this.checkpoints.discard();
		this.observations.resetMemory();
		this.profileLoaded = false;
		this.checkpointIdentityValue = undefined;
		await previous?.shutdown().catch(() => undefined);
		const pending = this.beginStartup(context, signal, skipProfile);
		await pending;
		return this.observations.takeNotice();
	}

	async invalidateKernel(notice = NOTEBOOK_INTERRUPTED_NOTICE): Promise<void> {
		const kernel = this.kernelValue;
		this.kernelValue = undefined;
		this.runtimeHealthValue = "invalidated";
		this.startup = undefined;
		this.observations.resetMemory();
		this.profileLoaded = false;
		this.checkpointIdentityValue = undefined;
		this.observations.addNotice(notice);
		await kernel?.shutdown().catch(() => undefined);
	}

	async recoverFromBootstrapFailure(value: unknown): Promise<boolean> {
		if (!isNotebookBootstrapFailure(value)) return false;
		if (this.kernelValue)
			await this.invalidateKernel(NOTEBOOK_BOOTSTRAP_NOTICE);
		return true;
	}

	async stopWithoutCheckpoint(): Promise<void> {
		this.startupAbort?.abort(new Error("Notebook state is being reset"));
		await this.startup?.catch(() => undefined);
		const previous = this.kernelValue;
		this.kernelValue = undefined;
		this.runtimeHealthValue = "not_started";
		this.startup = undefined;
		await this.checkpoints.discard();
		this.observations.resetMemory();
		this.profileLoaded = false;
		this.checkpointIdentityValue = undefined;
		this.observations.clearNotice();
		await previous?.shutdown().catch(() => undefined);
	}

	async abortStartup(reason: Error): Promise<void> {
		this.startupAbort?.abort(reason);
		await this.startup?.catch(() => undefined);
	}

	async shutdown(): Promise<void> {
		await this.abortStartup(new Error("Notebook session is shutting down"));
		try {
			this.observations.materializeJournal();
		} catch {}
		const kernel = this.kernelValue;
		this.kernelValue = undefined;
		this.runtimeHealthValue = "not_started";
		this.startup = undefined;
		this.startupAbort = undefined;
		this.identityValue = undefined;
		this.checkpointIdentityValue = undefined;
		this.checkpoints.reset();
		this.observations.clear();
		this.baseline.clear();
		this.profileLoaded = false;
		await kernel?.shutdown().catch(() => undefined);
		await this.bridge.shutdown();
	}

	kernel(): DenoJupyterKernel | undefined {
		return this.kernelValue;
	}
	runtimeHealth(): NotebookRuntimeHealth {
		return { state: this.runtimeHealthValue };
	}
	runtimeHealthFor(context: NotebookSessionContext): NotebookRuntimeHealth {
		return this.identityMatches(context)
			? this.runtimeHealth()
			: { state: "not_started" };
	}
	baselineNames(): ReadonlySet<string> {
		return this.baseline;
	}
	configuredProfileLoaded(): boolean {
		return this.profileLoaded;
	}
	retainedBindings(): RetainedProjectBinding[] {
		return this.checkpointIdentityValue
			? readRetainedProjectBindings(
					this.checkpointIdentityValue,
					this.checkpointMaxBytes,
				)
			: [];
	}
	private async start(
		context: NotebookSessionContext,
		signal?: AbortSignal,
		skipProfile = false,
	): Promise<void> {
		this.identityValue = sessionIdentity(context);
		this.observations.recordMemory(undefined);
		const started = await startNotebookSession({
			context,
			runtime:
				skipProfile && this.options.profile
					? { ...this.options, profile: undefined }
					: this.options,
			bridge: this.bridge,
			checkpointMaxBytes: this.checkpointMaxBytes,
			onKernelFailure: (kernel) => this.handleKernelFailure(kernel),
			...(signal ? { signal } : {}),
		});
		this.kernelValue = started.kernel;
		this.observations.started(started.journal);
		this.checkpointIdentityValue = started.checkpointIdentity;
		this.baseline = started.baselineNames;
		this.profileLoaded = started.configuredProfileLoaded;
		this.runtimeHealthValue = "ready";
		this.checkpoints.configure(
			started.checkpointIdentity,
			started.baselineNames,
			started.projectBaseline,
		);
		if (started.restoreNotice) {
			this.observations.addNotice(started.restoreNotice);
		}
	}

	private handleKernelFailure(kernel: DenoJupyterKernel): void {
		if (this.kernelValue !== kernel) return;
		this.kernelValue = undefined;
		this.runtimeHealthValue = "invalidated";
		this.startup = undefined;
		this.observations.resetMemory();
		this.profileLoaded = false;
		this.checkpointIdentityValue = undefined;
		this.observations.addNotice(NOTEBOOK_KERNEL_FAILURE_NOTICE);
	}

	private beginStartup(
		context: NotebookSessionContext,
		signal?: AbortSignal,
		skipProfile = false,
	): Promise<void> {
		const startupAbort = new AbortController();
		const startupSignal = signal
			? AbortSignal.any([signal, startupAbort.signal])
			: startupAbort.signal;
		this.startupAbort = startupAbort;
		const pending = this.start(context, startupSignal, skipProfile)
			.catch((error) => {
				if (this.startup === pending) this.startup = undefined;
				throw error;
			})
			.finally(() => {
				if (this.startupAbort === startupAbort) this.startupAbort = undefined;
			});
		this.startup = pending;
		return pending;
	}
}

function sessionIdentity(context: NotebookSessionContext): string {
	return `${notebookSessionIdentity(context)}\0${resolveNotebookProject(context.cwd)}`;
}
