// Adapted from pi-codex-conversion at 84bd5bce, MIT. See ../NOTICE.
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotebookExecutionRuntime } from "./execution-runtime.ts";
import { prepareIsolatedNotebookStorage } from "./isolated-storage.ts";
import { saveNotebookProfile } from "./profile-state.ts";
import { resolveNotebookProject } from "./project-identity.ts";
import type {
	NotebookRuntimeOptions,
	NotebookToolDefinition,
	RuntimeResponse,
	ToolExecutionContext,
} from "./runtime-contract.ts";
import { notebookSessionIdentity } from "./session-identity.ts";
import { NotebookSessionRuntime } from "./session-runtime.ts";

const MAX_ISOLATED_KERNELS = 4;

interface IsolatedRun {
	runtime: NotebookExecutionRuntime;
	session: NotebookSessionRuntime;
	controller: AbortController;
	ready: Promise<void>;
}

// Each fork owns its bridge and storage. Neither startup hooks nor checkpoint
// debounce can publish its bindings/pins into the ordinary session's baseline.
export class NotebookIsolatedRuntime {
	private readonly runs = new Map<string, IsolatedRun>();
	private readonly starting = new Set<IsolatedRun>();
	private stopping = false;
	private readonly options: NotebookRuntimeOptions;

	private readonly readCommitted: (
		capture: () => Promise<void>,
	) => Promise<void>;
	private identity: string | undefined;
	private readonly disposal = new WeakMap<IsolatedRun, Promise<void>>();

	constructor(
		options: NotebookRuntimeOptions,
		readCommitted: (capture: () => Promise<void>) => Promise<void>,
	) {
		this.options = options;
		this.readCommitted = readCommitted;
	}

	identityMatches(context: ToolExecutionContext): boolean {
		return !this.identity || this.identity === isolatedSessionIdentity(context);
	}

	has(cellId: string): boolean {
		return this.runs.has(cellId);
	}

	async execute(
		source: string,
		context: ToolExecutionContext,
		signal: AbortSignal | undefined,
		tools: NotebookToolDefinition[],
	): Promise<RuntimeResponse> {
		signal?.throwIfAborted();
		if (this.stopping)
			throw new Error("Notebook is stopping; retry after restart completes");
		if (this.runs.size + this.starting.size >= MAX_ISOLATED_KERNELS)
			throw new Error(
				`Notebook allows ${MAX_ISOLATED_KERNELS} isolated cells at a time; wait for or terminate an isolated cell first`,
			);
		const extension = context.sessionContext;
		if (!extension) throw new Error("Notebook requires a session context");
		this.identity = isolatedSessionIdentity(context);
		const controller = new AbortController();
		const runSignal = signal
			? AbortSignal.any([signal, controller.signal])
			: controller.signal;
		const directory = mkdtempSync(join(tmpdir(), "pi-deno-isolated-"));
		const candidate = `isolated-${randomUUID()}`;
		let session!: NotebookSessionRuntime;
		const runtime = new NotebookExecutionRuntime(
			() => session,
			(ctx, abort) => session.ensure(ctx, abort),
			async (cell) => {
				try {
					if (cell.result?.status === "ok" && !cell.controller.signal.aborted) {
						const saved = await saveNotebookProfile({
							name: candidate,
							kernel: session.kernel()!,
							project: resolveNotebookProject(context.cwd),
							agentDir: this.options.agentDir,
							baselineNames: session.baselineNames(),
							maxBytes: session.checkpointMaxBytes,
							signal: cell.controller.signal,
						});
						cell.emit([
							{
								type: "input_text",
								text: `Isolated state was not adopted. Saved candidate ${candidate}: ${saved.values} value(s), ${saved.definitions} definition(s), ${saved.skipped} skipped. Use notebook load with this name; existing binding collisions prevent overwrite. External tool and file effects are shared.`,
							},
						]);
					}
				} finally {
					try {
						await session.shutdown();
					} finally {
						rmSync(directory, { recursive: true, force: true });
					}
				}
			},
			candidate,
		);
		session = new NotebookSessionRuntime({
			runtime: { ...this.options, agentDir: directory, storage: undefined },
			bridge: runtime.bridge,
			runningCellId: () => runtime.runningCellId(),
		});
		const run: IsolatedRun = {
			runtime,
			session,
			controller,
			ready: Promise.resolve(),
		};
		this.starting.add(run);
		run.ready = prepareIsolatedNotebookStorage(
			this.options,
			context,
			directory,
			this.readCommitted,
			runSignal,
		);
		try {
			await run.ready;
			runSignal.throwIfAborted();
			const pending = runtime.execute(source, context, runSignal, tools);
			// The cell identity is assigned after asynchronous preparation; keep the
			// reservation until execute has returned its first observable response.
			const response = await pending;
			this.starting.delete(run);
			if (response.kind === "yielded") this.runs.set(response.cellId, run);
			else await this.dispose(run);
			return response;
		} catch (error) {
			await this.dispose(run);
			throw error;
		} finally {
			this.starting.delete(run);
		}
	}

	async wait(
		cellId: string,
		yieldTimeMs: number,
		context: ToolExecutionContext,
		signal?: AbortSignal,
	): Promise<RuntimeResponse> {
		const run = this.runs.get(cellId)!;
		try {
			const response = await run.runtime.wait(
				cellId,
				yieldTimeMs,
				context,
				signal,
			);
			if (response.kind === "yielded") return response;
			this.runs.delete(cellId);
			await this.dispose(run);
			return response;
		} catch (error) {
			this.runs.delete(cellId);
			await this.dispose(run);
			throw error;
		}
	}

	async terminate(
		cellId: string,
		context: ToolExecutionContext,
		signal?: AbortSignal,
	): Promise<RuntimeResponse> {
		const run = this.runs.get(cellId)!;
		try {
			return await run.runtime.terminate(cellId, context, signal);
		} finally {
			this.runs.delete(cellId);
			await this.dispose(run);
		}
	}

	async shutdown(): Promise<void> {
		this.stopping = true;
		try {
			await Promise.all(
				[...new Set([...this.runs.values(), ...this.starting])].map((run) =>
					this.dispose(run),
				),
			);
		} finally {
			this.runs.clear();
			this.starting.clear();
			this.identity = undefined;
			this.stopping = false;
		}
	}

	private dispose(run: IsolatedRun): Promise<void> {
		const existing = this.disposal.get(run);
		if (existing) return existing;
		const operation = this.disposeRun(run);
		this.disposal.set(run, operation);
		return operation;
	}

	private async disposeRun(run: IsolatedRun): Promise<void> {
		run.controller.abort();
		await run.ready.catch(() => undefined);
		await run.session.abortStartup(new Error("Isolated cell stopped"));
		await run.runtime.stopActive().catch(() => undefined);
		try {
			await run.session.shutdown();
		} finally {
			run.runtime.clear();
			rmSync(run.session.options.agentDir, { recursive: true, force: true });
		}
	}
}

function isolatedSessionIdentity(context: ToolExecutionContext): string {
	return `${resolveNotebookProject(context.cwd)}\0${context.sessionContext ? notebookSessionIdentity(context.sessionContext) : ""}`;
}
