// Adapted from pi-codex-conversion at b2006db9def12c373ae48e70044d30f7d6b7e34f, MIT. See ../NOTICE.
import { globMatcher } from "./glob.ts";
import type { DenoJupyterKernel } from "./jupyter-kernel.ts";
import type { NotebookLifecycleHost } from "./lifecycle-contract.ts";
import {
	formatStatus,
	type NotebookStatusDetails,
	remainingDetailsBudget,
	takeDetailValues,
	withinNameBudget,
} from "./lifecycle-result.ts";
import {
	lifecycleMarker,
	type NotebookKernelStatus,
	notebookStatusSource,
	parseNotebookRuntimeResult,
} from "./lifecycle-runtime.ts";
import type { NotebookControlResult } from "./runtime-contract.ts";
export const NOTEBOOK_BINDING_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const STATUS_TIMEOUT_MS = 8_000;
export async function inspectNotebookStatus(
	host: Pick<
		NotebookLifecycleHost,
		| "kernel"
		| "activeCellId"
		| "retainedBindings"
		| "baselineNames"
		| "metadata"
	>,
	query: string | undefined,
	signal?: AbortSignal,
): Promise<NotebookControlResult> {
	const kernel = host.kernel()!;
	const activeCell = host.activeCellId();
	const statusSignal = signal
		? AbortSignal.any([signal, AbortSignal.timeout(STATUS_TIMEOUT_MS)])
		: AbortSignal.timeout(STATUS_TIMEOUT_MS);
	const allNames = activeCell
		? []
		: await notebookUserBindingNames(host, kernel, statusSignal);
	const matches =
		query === undefined ? [] : allNames.filter(globMatcher(query));
	const selected = withinNameBudget(matches);
	const retained = host.retainedBindings();
	const retainedByName = new Map(
		retained.map((binding) => [binding.name, binding]),
	);
	let runtime: NotebookKernelStatus | undefined;
	if (!activeCell) {
		const marker = lifecycleMarker();
		runtime = parseNotebookRuntimeResult<NotebookKernelStatus>(
			await kernel.execute(notebookStatusSource(selected, marker), {
				signal: statusSignal,
			}),
			marker,
		);
	}
	const metadata = host.metadata();
	const inspectedMatches = (runtime?.bindings ?? []).map((binding) => {
		const retainedBinding = retainedByName.get(binding.name);
		return {
			...binding,
			...(retainedBinding
				? {
						bytes: retainedBinding.bytes,
						updatedAt: retainedBinding.updatedAt,
						pinned: retainedBinding.pinned,
						hook: retainedBinding.hook,
						...(retainedBinding.description === undefined
							? {}
							: { description: retainedBinding.description }),
						...(retainedBinding.usage === undefined
							? {}
							: { usage: retainedBinding.usage }),
					}
				: {}),
		};
	});
	const pinned = retained.filter((binding) => binding.pinned);
	const unpinned = retained
		.filter(({ pinned }) => !pinned)
		.sort((left, right) => right.bytes - left.bytes);
	const largestUnpinned = unpinned.slice(0, 8);
	const baseDetails: NotebookStatusDetails = {
		state: activeCell ? "running" : "idle",
		...(activeCell ? { activeCell } : {}),
		userBindings: activeCell ? undefined : allNames.length,
		userCells: metadata.userCells,
		...(metadata.startedAt
			? { startedAt: new Date(metadata.startedAt).toISOString() }
			: {}),
		memory: runtime?.memory ?? metadata.memory,
		checkpoint: metadata.checkpoint,
		retainedBindings: retained.length,
		retainedBytes: retained.reduce(
			(total, binding) => total + binding.bytes,
			0,
		),
		pinnedBindings: pinned.length,
		pinned: [],
		omittedPinned: pinned.length,
		largestUnpinned: [],
		omittedLargestUnpinned: unpinned.length,
		...(query === undefined
			? {}
			: {
					query,
					matches: [],
					omittedMatches: matches.length,
				}),
	};
	const detailBudget = remainingDetailsBudget(baseDetails);
	const reportedMatches = takeDetailValues(inspectedMatches, detailBudget);
	const reportedPinned = takeDetailValues(pinned, detailBudget);
	const reportedLargestUnpinned = takeDetailValues(
		largestUnpinned,
		detailBudget,
	);
	const details: NotebookStatusDetails = {
		...baseDetails,
		pinned: reportedPinned,
		omittedPinned: pinned.length - reportedPinned.length,
		largestUnpinned: reportedLargestUnpinned,
		omittedLargestUnpinned: unpinned.length - reportedLargestUnpinned.length,
		...(query === undefined
			? {}
			: {
					matches: reportedMatches,
					omittedMatches: Math.max(0, matches.length - reportedMatches.length),
				}),
	};
	return { message: formatStatus(details), details };
}

export async function notebookUserBindingNames(
	host: Pick<NotebookLifecycleHost, "baselineNames">,
	kernel: DenoJupyterKernel,
	signal?: AbortSignal,
): Promise<string[]> {
	const baseline = host.baselineNames();
	return [...new Set(await kernel.complete("", 0, signal))]
		.filter(
			(name) => NOTEBOOK_BINDING_IDENTIFIER.test(name) && !baseline.has(name),
		)
		.sort();
}
