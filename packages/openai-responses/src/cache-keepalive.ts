import type { Api, Model } from "@earendil-works/pi-ai";
import { noThrowCodexDiagnosticsSink } from "./openai-codex/diagnostic-failure.ts";
import type {
	CodexDiagnosticsSink,
	CodexPrewarmResult,
	ResponsesBody,
} from "./openai-codex/types.ts";
import { assertResponsesBody } from "./preparation.ts";
import type { PrewarmOptions } from "./prewarm.ts";

export interface CacheKeepalivePolicy {
	/** Astra, Sol and Terra. Default false. */
	cacheKeepalive?: boolean;
	/** Default 25. */
	cacheKeepaliveIntervalMinutes?: 25 | 55;
	/** Luna duration cap. Default 0, disabled. */
	lunaCacheKeepaliveMinutes?: 0 | 5 | 10 | 15;
	/** Default 2.5. */
	lunaCacheKeepaliveIntervalMinutes?: 2.5 | 4.5;
}

export type CacheKeepaliveOptions = Omit<PrewarmOptions, "mode"> & {
	policy: CacheKeepalivePolicy;
	/** Recheck idle, quota, credentials and prepared snapshot identity synchronously. */
	isCurrent: () => boolean;
	/** Account for generated usage, including a result arriving during cancellation. */
	onResult: (result: CodexPrewarmResult) => void | Promise<void>;
	onError: (error: unknown) => void | Promise<void>;
};

function resolvePlan(modelId: string, policy: CacheKeepalivePolicy) {
	const id = modelId.split("/").at(-1)?.trim().toLowerCase();
	const family =
		id === "gpt-reserve"
			? "luna"
			: /^gpt-\d+(?:\.\d+)*-(astra|sol|terra|luna)(?:-|$)/.exec(id ?? "")?.[1];
	const minutes = policy.lunaCacheKeepaliveMinutes ?? 0;
	const lunaInterval = policy.lunaCacheKeepaliveIntervalMinutes ?? 2.5;
	const interval = policy.cacheKeepaliveIntervalMinutes ?? 25;
	if (
		![0, 5, 10, 15].includes(minutes) ||
		![2.5, 4.5].includes(lunaInterval) ||
		![25, 55].includes(interval) ||
		(policy.cacheKeepalive !== undefined &&
			typeof policy.cacheKeepalive !== "boolean")
	)
		throw new Error("Invalid cache keepalive policy");
	if (family === "luna")
		return minutes === 0
			? undefined
			: {
					intervalMs: lunaInterval * 60_000,
					maxOperations: Math.floor(minutes / lunaInterval),
					maxDurationMs: minutes * 60_000,
				};
	if (["astra", "sol", "terra"].includes(family ?? "") && policy.cacheKeepalive)
		return {
			intervalMs: interval * 60_000,
			maxOperations: undefined,
			maxDurationMs: undefined,
		};
	return undefined;
}

/** Provider-owned timers and tasks. Hosts supply authority, never an inferred transcript. */
export function createCacheKeepalive(
	warm: (
		model: Model<Api>,
		body: ResponsesBody,
		options: PrewarmOptions,
	) => Promise<CodexPrewarmResult | undefined>,
	getDiagnostics: (sessionId: string) => CodexDiagnosticsSink | undefined,
) {
	const arms = new Map<string, { cancel: () => void }>();
	const tasks = new Map<Promise<void>, string>();
	let closed = false;
	const cancel = (sessionId: string) => arms.get(sessionId)?.cancel();
	return {
		cancel,
		async drain(sessionId?: string) {
			await Promise.all(
				[...tasks]
					.filter(([, id]) => sessionId === undefined || id === sessionId)
					.map(([task]) => task),
			);
		},
		close() {
			closed = true;
			for (const arm of arms.values()) arm.cancel();
		},
		arm(
			model: Model<Api>,
			body: ResponsesBody,
			options: CacheKeepaliveOptions,
		) {
			if (closed) throw new Error("OpenAI Responses provider is closed");
			cancel(options.sessionId);
			const snapshot = structuredClone(body);
			assertResponsesBody(snapshot);
			// Payload hooks may select another model. Its paid policy, not the original handle's, is authoritative.
			const plan = resolvePlan(snapshot.model, options.policy);
			if (!plan) return () => {};
			if (!options.apiKey || !options.sessionId)
				throw new Error("Cache keepalive requires apiKey and sessionId");
			if (
				typeof options.isCurrent !== "function" ||
				typeof options.onError !== "function" ||
				typeof options.onResult !== "function"
			)
				throw new Error(
					"Cache keepalive requires currentness, result and error callbacks",
				);
			if (snapshot.previous_response_id || options.cacheRetention === "none")
				throw new Error(
					"Cache keepalive requires a full cache-enabled prepared request",
				);
			if (options.signal?.aborted || !options.isCurrent()) return () => {};
			const selected = structuredClone(model);
			const {
				policy: _policy,
				isCurrent,
				onResult,
				onError,
				...request
			} = options;
			const preparedOptions = {
				...request,
				...(request.headers ? { headers: { ...request.headers } } : {}),
				...(request.env ? { env: { ...request.env } } : {}),
			};
			const controller = new AbortController();
			let timer: ReturnType<typeof setTimeout> | undefined;
			let completed = 0;
			const deadline =
				plan.maxDurationMs === undefined
					? undefined
					: Date.now() + plan.maxDurationMs;
			const diagnostics = noThrowCodexDiagnosticsSink(
				getDiagnostics(request.sessionId),
			);
			const record = (phase: "armed" | "started" | "applied" | "skipped") =>
				diagnostics?.({
					type: "keepalive",
					phase,
					strategy: "generated-current",
					requestSource: "captured",
					...(phase === "armed" ? { intervalMs: plan.intervalMs } : {}),
					...(phase === "applied" ? { action: "generated-refresh" } : {}),
				});
			const arm = {
				cancel() {
					if (timer !== undefined) clearTimeout(timer);
					controller.abort();
					request.signal?.removeEventListener("abort", arm.cancel);
					if (arms.get(request.sessionId) === arm)
						arms.delete(request.sessionId);
				},
			};
			const report = async (error: unknown) => {
				try {
					await onError(error);
				} catch (callbackError) {
					arm.cancel();
					console.error(
						"Cache keepalive error callback failed",
						callbackError,
						"Original failure:",
						error,
					);
				}
			};
			const schedule = () => {
				if (controller.signal.aborted) return;
				if (
					(plan.maxOperations !== undefined &&
						completed >= plan.maxOperations) ||
					(deadline !== undefined && Date.now() + plan.intervalMs > deadline)
				) {
					arm.cancel();
					return;
				}
				record("armed");
				timer = setTimeout(() => {
					timer = undefined;
					const task = run().catch(async (error) => {
						arm.cancel();
						await report(error);
					});
					tasks.set(task, request.sessionId);
					void task.finally(() => tasks.delete(task));
				}, plan.intervalMs);
				timer.unref?.();
			};
			const run = async () => {
				try {
					if (controller.signal.aborted) return;
					if (
						!isCurrent() ||
						(deadline !== undefined && Date.now() > deadline)
					) {
						record("skipped");
						arm.cancel();
						return;
					}
					completed++;
					record("started");
					const result = await warm(selected, structuredClone(snapshot), {
						...preparedOptions,
						signal: controller.signal,
						mode: "keepalive",
					});
					if (result) await onResult(result);
					if (controller.signal.aborted) return;
					if (!result) {
						record("skipped");
						arm.cancel();
						return;
					}
					record("applied");
				} catch (error) {
					if (!controller.signal.aborted) await report(error);
				}
				if (!controller.signal.aborted) schedule();
			};
			arms.set(request.sessionId, arm);
			request.signal?.addEventListener("abort", arm.cancel, { once: true });
			if (request.signal?.aborted) arm.cancel();
			else schedule();
			return arm.cancel;
		},
	};
}
