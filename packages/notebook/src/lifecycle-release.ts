// Adapted from pi-codex-conversion at b2006db9def12c373ae48e70044d30f7d6b7e34f, MIT. See ../NOTICE.
import { globMatcher } from "./glob.ts";
import type { NotebookLifecycleHost } from "./lifecycle-contract.ts";
import {
	NOTEBOOK_BINDING_IDENTIFIER,
	notebookUserBindingNames,
} from "./lifecycle-inspection.ts";
import {
	boundedReleaseDetails,
	formatNameList,
	formatRelease,
} from "./lifecycle-result.ts";
import {
	lifecycleMarker,
	type NotebookKernelStatus,
	type NotebookReleaseResult,
	notebookDisposeSource,
	notebookReleaseSource,
	notebookStatusSource,
	parseNotebookRuntimeResult,
} from "./lifecycle-runtime.ts";
import type {
	NotebookControlResult,
	ToolExecutionContext,
} from "./runtime-contract.ts";

type BindingHost = Pick<
	NotebookLifecycleHost,
	| "kernel"
	| "activeCellId"
	| "retainedBindings"
	| "baselineNames"
	| "checkpoint"
	| "markChanged"
	| "restart"
	| "metadata"
>;
export class NotebookReleaseController {
	private readonly host: BindingHost;
	constructor(host: BindingHost) {
		this.host = host;
	}
	async disposeAll(
		signal?: AbortSignal,
	): Promise<NotebookReleaseResult | undefined> {
		const kernel = this.host.kernel();
		if (!kernel || this.host.activeCellId()) return undefined;
		const names = await notebookUserBindingNames(this.host, kernel, signal);
		if (names.length === 0) return { released: [], disposed: [], failures: [] };
		const marker = lifecycleMarker();
		return parseNotebookRuntimeResult<NotebookReleaseResult>(
			await kernel.execute(notebookDisposeSource(names, marker), { signal }),
			marker,
		);
	}

	async release(
		names: string[],
		context: ToolExecutionContext,
		signal?: AbortSignal,
		preservedNames: string[] = [],
	): Promise<NotebookControlResult> {
		const activeCell = this.host.activeCellId();
		if (activeCell)
			throw new Error(
				`Cannot release notebook state while exec cell "${activeCell}" is running; terminate or restart it first`,
			);
		const kernel = this.host.kernel()!;
		const available = new Set(
			await notebookUserBindingNames(this.host, kernel),
		);
		const invalid = names.filter(
			(name) => !NOTEBOOK_BINDING_IDENTIFIER.test(name) || !available.has(name),
		);
		if (invalid.length > 0)
			throw new Error(
				`Notebook bindings not found or not releasable: ${invalid.join(", ")}`,
			);
		const pinned = new Set(
			this.host
				.retainedBindings()
				.filter((binding) => binding.pinned)
				.map(({ name }) => name),
		);
		const protectedNames = names.filter((name) => pinned.has(name));
		if (protectedNames.length > 0)
			throw new Error(
				`Pinned notebook bindings cannot be released: ${formatNameList(protectedNames)}; unpin them first`,
			);
		const statusMarker = lifecycleMarker();
		const status = parseNotebookRuntimeResult<NotebookKernelStatus>(
			await kernel.execute(notebookStatusSource(names, statusMarker), {
				signal,
			}),
			statusMarker,
		);
		const restartRequired = status.bindings.some(
			({ globalProperty }) => !globalProperty,
		);
		let result: NotebookReleaseResult;
		if (restartRequired) {
			this.host.markChanged();
			await this.host.checkpoint(new Set(names));
			const disposal = await this.disposeAll(signal);
			const extension = context.sessionContext;
			if (!extension)
				throw new Error("Notebook release requires a notebook session context");
			await this.host.restart(extension, signal);
			result = {
				released: [...names],
				disposed: disposal?.disposed ?? [],
				failures: disposal?.failures ?? [],
			};
		} else {
			const marker = lifecycleMarker();
			result = parseNotebookRuntimeResult<NotebookReleaseResult>(
				await kernel.execute(notebookReleaseSource(names, marker), { signal }),
				marker,
			);
			if (result.released.length > 0) {
				this.host.markChanged();
				await this.host.checkpoint(new Set(result.released));
			}
		}
		const remaining = new Set(
			await notebookUserBindingNames(this.host, this.host.kernel()!),
		);
		for (const name of [...result.released]) {
			if (!remaining.has(name)) continue;
			result.released.splice(result.released.indexOf(name), 1);
			result.failures.push({
				name,
				reason: "concurrent project state retained this binding",
			});
		}
		const details = boundedReleaseDetails(
			result,
			preservedNames,
			restartRequired,
			this.host.metadata().checkpoint,
		);
		return { message: formatRelease(result, restartRequired), details };
	}

	async prune(
		query: string,
		context: ToolExecutionContext,
		signal?: AbortSignal,
	): Promise<NotebookControlResult> {
		const kernel = this.host.kernel()!;
		const matches = (await notebookUserBindingNames(this.host, kernel)).filter(
			globMatcher(query),
		);
		const pinned = new Set(
			this.host
				.retainedBindings()
				.filter((binding) => binding.pinned)
				.map(({ name }) => name),
		);
		const protectedNames = matches.filter((name) => pinned.has(name));
		const names = matches.filter((name) => !pinned.has(name));
		if (names.length === 0) {
			const details = boundedReleaseDetails(
				{ released: [], disposed: [], failures: [] },
				protectedNames,
				false,
				this.host.metadata().checkpoint,
			);
			return {
				message: `No unpinned notebook bindings matched ${JSON.stringify(query)}${protectedNames.length > 0 ? `; protected: ${formatNameList(protectedNames)}` : ""}`,
				details: { ...details, query },
			};
		}
		const released = await this.release(names, context, signal, protectedNames);
		return {
			message: `${released.message}${protectedNames.length > 0 ? `\nPinned matches preserved: ${formatNameList(protectedNames)}` : ""}`,
			details: { ...released.details, query },
		};
	}
}
