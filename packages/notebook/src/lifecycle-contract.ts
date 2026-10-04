// Adapted from pi-codex-conversion at b2006db9def12c373ae48e70044d30f7d6b7e34f, MIT. See ../NOTICE.
import type { DenoJupyterKernel } from "./jupyter-kernel.ts";
import type { ProjectStatePinUpdate } from "./project-state-merge.ts";
import type { RetainedProjectBinding } from "./project-state-metadata.ts";
import type {
	NotebookControlResult,
	NotebookMemoryUsage,
	NotebookSessionContext,
	ToolExecutionContext,
} from "./runtime-contract.ts";
import type { NotebookRuntimeHealth } from "./runtime-health.ts";
export interface NotebookLifecycleHost {
	prepare(context: ToolExecutionContext, signal?: AbortSignal): Promise<void>;
	diagnostics(
		context: ToolExecutionContext,
		signal?: AbortSignal,
	): Promise<NotebookControlResult>;
	reset(
		context: ToolExecutionContext,
		signal?: AbortSignal,
	): Promise<NotebookControlResult>;
	unpinWithoutStartup(
		names: string[],
		context: ToolExecutionContext,
		signal?: AbortSignal,
	): Promise<NotebookControlResult>;
	kernel(): DenoJupyterKernel | undefined;
	activeCellId(): string | undefined;
	stopActive(): Promise<string | undefined>;
	checkpoint(
		excludeNames?: ReadonlySet<string>,
		pins?: ProjectStatePinUpdate,
	): Promise<void>;
	retainedBindings(): RetainedProjectBinding[];
	promoteBindings(names: string[]): Promise<() => Promise<void>>;
	markChanged(): void;
	restart(
		context: NotebookSessionContext,
		signal?: AbortSignal,
	): Promise<string | undefined>;
	rollback(context: NotebookSessionContext): Promise<void>;
	baselineNames(): ReadonlySet<string>;
	profileStorage(): { agentDir: string; maxBytes: number };
	runtimeHealth(): NotebookRuntimeHealth;
	metadata(): {
		startedAt?: number | undefined;
		userCells: number;
		memory?: NotebookMemoryUsage | undefined;
		checkpoint: Record<string, unknown>;
	};
}
