import { isAbsolute } from "node:path";
import { Worker } from "node:worker_threads";
import type { HistoryIndexRequest, HistoryRanker } from "./history-ranker.ts";

import type {
	HistoryWorkerMessage,
	HistoryWorkerOptions,
} from "./history-search-worker.ts";

/** Native capability: path must be an explicitly granted absolute host index path.
 * Requires Node >=22.19 with node:sqlite/FTS5; never imported by the portable entry.
 * Close after draining tool calls. No worker survives process restart.
 */
export function createNodeHistoryRanker(options: {
	path: string;
}): HistoryRanker & {
	close(): Promise<void>;
} {
	if (!isAbsolute(options.path))
		throw new Error("History index requires an absolute host-granted path");
	const workers = new Set<Worker>();
	let pending = Promise.resolve();
	let closed = false;
	return {
		async refresh(request) {
			if (closed) throw new Error("History ranker is closed");
			request.signal?.throwIfAborted();
			await schedule(request);
		},
		async search(request) {
			request.signal?.throwIfAborted();
			if (closed) throw new Error("History ranker is closed");
			const words = [
				...new Set(
					request.query.toLowerCase().match(/[\p{L}\p{N}\p{M}\p{Co}]+/gu),
				),
			];
			if (!words.length)
				throw new Error("Supply at least one word or number to search history");
			return schedule(request, words.map((word) => `"${word}"`).join(" AND "));
		},
		async close() {
			closed = true;
			await Promise.all([...workers].map((worker) => worker.terminate()));
		},
	};
	function schedule(
		request: HistoryIndexRequest & { limit?: number; recentFirst?: boolean },
		match?: string,
	): Promise<string[]> {
		// Keep complete index transactions ordered, without retaining their corpora.
		const operation = pending.then(() => run(request, match));
		pending = operation.then(
			() => {},
			() => {},
		);
		if (!request.signal) return operation;
		const signal = request.signal;
		return new Promise((resolve, reject) => {
			const abort = () =>
				reject(signal.reason ?? new Error("History search cancelled"));
			signal.addEventListener("abort", abort, { once: true });
			operation
				.then(resolve, reject)
				.finally(() => signal.removeEventListener("abort", abort));
			if (signal.aborted) abort();
		});
	}
	function run(
		request: HistoryIndexRequest & {
			limit?: number;
			recentFirst?: boolean;
		},
		match?: string,
	): Promise<string[]> {
		request.signal?.throwIfAborted();
		if (closed) return Promise.reject(new Error("History ranker is closed"));
		return new Promise<string[]>((resolve, reject) => {
			const iterator = (async function* () {
				yield* request.items;
			})();
			const worker = new Worker(
				new URL(
					import.meta.url.endsWith(".ts")
						? "./history-search-worker.ts"
						: "./history-search-worker.js",
					import.meta.url,
				),
				{
					workerData: {
						path: options.path,
						scope: request.scope,
						limit: request.limit,
						recentFirst: request.recentFirst,
						match,
					} satisfies HistoryWorkerOptions,
					execArgv: [],
				},
			);
			workers.add(worker);
			let settled = false;
			const finish = (error?: Error, ids?: string[]) => {
				if (settled) return;
				settled = true;
				request.signal?.removeEventListener("abort", abort);
				void iterator.return(undefined).catch(() => {});
				void worker.terminate().then(() => {
					workers.delete(worker);
					if (error) reject(error);
					else resolve(ids ?? []);
				}, reject);
			};
			const abort = () =>
				finish(
					new Error("History search cancelled; retry the query", {
						cause: request.signal?.reason,
					}),
				);
			request.signal?.addEventListener("abort", abort, { once: true });
			worker.on("message", async (value: unknown) => {
				if (settled) return;
				if (value && typeof value === "object" && "ready" in value) {
					try {
						const batch: { id: string; content: string }[] = [];
						let chars = 0;
						while (batch.length < 128 && chars < 1_000_000) {
							request.signal?.throwIfAborted();
							const next = await iterator.next();
							if (settled) return;
							if (next.done) break;
							batch.push(next.value);
							chars += next.value.content.length;
						}
						worker.postMessage(
							(batch.length
								? { items: batch }
								: { finish: true }) satisfies HistoryWorkerMessage,
						);
					} catch (error) {
						finish(
							error instanceof Error
								? error
								: new Error("History index input failed", { cause: error }),
						);
					}
					return;
				}
				if (
					value &&
					typeof value === "object" &&
					"ids" in value &&
					Array.isArray(value.ids) &&
					value.ids.every((id) => typeof id === "string")
				)
					finish(undefined, value.ids);
				else
					finish(
						new Error(
							"Ranked history search is unavailable; list and read remain available. Check the native index capability or disable ranked history.",
							{
								cause:
									value && typeof value === "object" && "error" in value
										? value.error
										: value,
							},
						),
					);
			});
			worker.on("error", (error) =>
				finish(
					new Error(
						"Ranked history search is unavailable; check the native index capability or disable ranked history",
						{ cause: error },
					),
				),
			);
			worker.on("exit", () =>
				finish(new Error("History worker stopped; retry the query")),
			);
			if (request.signal?.aborted) abort();
		});
	}
}
