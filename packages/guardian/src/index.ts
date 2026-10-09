import { isDeepStrictEqual } from "node:util";
import type { FetchFunction } from "@earendil-works/pi-ai";
import {
	AgentDoc,
	type ConversationId,
	defineExtension,
	GenerationTask,
	hook,
	LiveDoc,
	ProviderDoc,
	type TaskId,
	ToolTask,
} from "@earendil-works/pi-durable";
import { ToolOriginDoc } from "../../execution/src/tool-origin.ts";
import {
	type CompletionObservation,
	captureParent,
	type Parent,
	prepareParentRequest,
} from "./parents.ts";
import { reviewAction, serializeAction, serializeReview } from "./review.ts";

export type { CompletionObservation } from "./parents.ts";

import { decideAction, parseRules, type Rule } from "./scope.ts";

export interface GuardianOptions {
	/** Explicit policy snapshot. No ambient filesystem configuration is read. */
	rules?: unknown;
	enabled?: boolean;
	/** Native process isolation is required only for argument regex rules. */
	nativeRegex?: boolean;
	fetch?: FetchFunction;
	/** Exact conversation execution directory. Required for review rules, never inferred from host cwd. */
	cwdForConversation?: (conversationId: ConversationId) => string | undefined;
}
/** Install extension in each guarded agent and pass observeCompletion to the owned provider. */
export function createGuardian(options: GuardianOptions = {}) {
	let enabled = options.enabled ?? true;
	let revision = 0;
	let rules: Rule[] = [];
	let configError: string | undefined;
	const observations = new Map<string, CompletionObservation>();
	const parents = new Map<ConversationId, Parent>();
	const prepared = new Map<
		ConversationId,
		{ revision: number; taskId: TaskId; agent: string }
	>();
	const active = new Set<AbortController>();
	const canonicalRoute = (url: string | undefined) =>
		[
			"https://chatgpt.com/backend-api",
			"https://chatgpt.com/backend-api/codex",
			"https://chatgpt.com/backend-api/codex/responses",
		].includes(url?.replace(/\/+$/, "") ?? "");
	let last: "allow" | "deny" | "unavailable" | undefined;
	const invalidate = () => {
		revision++;
		observations.clear();
		parents.clear();
		prepared.clear();
		for (const controller of active) controller.abort();
	};
	const reload = (policy: unknown) => {
		invalidate();
		try {
			rules = parseRules(policy);
			configError = undefined;
		} catch {
			rules = [];
			configError = "Guardian configuration is invalid";
		}
	};
	reload(options.rules ?? { rules: [] });
	const observeCompletion = (observation: CompletionObservation) => {
		if (
			!enabled ||
			configError ||
			!rules.some((rule) => rule.action === "review")
		)
			return;
		if (
			!observation.canonicalSubscription ||
			observation.api !== "openai-codex-responses" ||
			observation.url !== "https://chatgpt.com/backend-api/codex/responses" ||
			!/^resp_[a-zA-Z0-9]+$/.test(observation.responseId) ||
			!observation.sessionId ||
			Buffer.byteLength(observation.requestBody) > 96 * 1024
		)
			return;
		// Bound unattached observations independently of conversation count.
		while (observations.size >= 8)
			observations.delete(observations.keys().next().value!);
		observations.set(observation.responseId, structuredClone(observation));
	};
	const prepareRequest = (
		body: unknown,
		model: { api: string; id: string; baseUrl?: string | undefined },
	) =>
		prepareParentRequest(
			body,
			model,
			enabled && !configError && rules.some((rule) => rule.action === "review"),
		);
	const extension = defineExtension({
		name: "guardian",
		hooks: [
			hook(GenerationTask, {
				async beforeRequest(_request, api, context) {
					parents.delete(api.conversationId);
					prepared.delete(api.conversationId);
					if (
						!enabled ||
						configError ||
						!rules.some((rule) => rule.action === "review")
					)
						return;
					const version = revision;
					try {
						const agent = serializeReview(
							await api.snapshot(AgentDoc, api.conversationId, context),
						);
						if (version !== revision) return;
						while (prepared.size >= 8)
							prepared.delete(prepared.keys().next().value!);
						prepared.set(api.conversationId, {
							revision: version,
							taskId: api.taskId,
							agent,
						});
					} catch {
						/* Unbounded authorization cannot prepare a parent. */
					}
				},
				async afterResponse(message, api, context) {
					const observation = message.responseId
						? observations.get(message.responseId)
						: undefined;
					if (message.responseId) observations.delete(message.responseId);
					parents.delete(api.conversationId);
					const request = prepared.get(api.conversationId);
					prepared.delete(api.conversationId);
					if (
						!enabled ||
						configError ||
						!observation ||
						!request ||
						request.revision !== revision ||
						request.taskId !== api.taskId ||
						message.stopReason !== "toolUse" ||
						message.provider !== observation.provider ||
						message.api !== observation.api ||
						message.model !== observation.model
					)
						return;
					const version = revision;
					const session = await api.snapshot(
						ProviderDoc,
						api.conversationId,
						context,
					);
					const live = await api.snapshot(LiveDoc, api.conversationId, context);
					if (
						revision !== version ||
						session?.sessionId !== observation.sessionId ||
						!live?.run
					)
						return;
					try {
						const agent = serializeReview(
							await api.snapshot(AgentDoc, api.conversationId, context),
						);
						if (version !== revision || request.agent !== agent) return;
					} catch {
						return;
					}
					const parent = captureParent(
						observation,
						message,
						live.run.taskId,
						request.agent,
					);
					if (!parent) return;
					while (parents.size >= 8)
						parents.delete(parents.keys().next().value!);
					parents.set(api.conversationId, parent);
				},
				afterTools(_assistant, _results, api) {
					parents.delete(api.conversationId);
				},
				onYield(_answer, api) {
					parents.delete(api.conversationId);
				},
			}),
			hook(ToolTask, {
				async beforeTool(call, api, context) {
					if (!enabled) return;
					if (configError) return { block: configError };
					const controller = new AbortController();
					const invocationSignal =
						"signal" in api && api.signal instanceof AbortSignal
							? api.signal
							: undefined;
					const signal = AbortSignal.any(
						[controller.signal, context.abortSignal, invocationSignal].filter(
							(value): value is AbortSignal => value !== undefined,
						),
					);
					active.add(controller);
					const version = revision;
					try {
						const agent = await api.snapshot(
							AgentDoc,
							api.conversationId,
							context,
						);
						const cwd = options.cwdForConversation?.(api.conversationId);
						const action = {
							toolName: call.name,
							input: call.arguments,
							toolCallId: call.id,
							cwd: cwd ?? "",
						};
						const exact = serializeAction(action);
						const decision = await decideAction(
							call.name,
							call.arguments,
							rules,
							signal,
							options.nativeRegex === true,
						);
						if (
							signal.aborted ||
							version !== revision ||
							!isDeepStrictEqual(
								agent,
								await api.snapshot(AgentDoc, api.conversationId, context),
							) ||
							exact !== serializeAction(action)
						)
							throw new Error("Stale matching");
						if (decision === "block")
							return {
								block:
									"Guardian blocked this action by a configured rule. Nothing executed.",
							};
						if (decision === "pass") return;
						if (!cwd)
							throw new Error("Conversation execution directory unavailable");
						const parent = parents.get(api.conversationId);
						const inherited = (
							await api.snapshot(ToolOriginDoc, api.taskId, context)
						)?.origin;
						const origin = inherited ?? {
							conversationId: api.conversationId,
							taskId: api.taskId,
							callId: call.id,
						};
						if (origin.conversationId !== api.conversationId)
							throw new Error("Origin belongs to another conversation");
						const live = await api.snapshot(
							LiveDoc,
							api.conversationId,
							context,
						);
						const slot = live?.tools?.find(
							(slot) =>
								slot.callId === origin.callId &&
								slot.taskId === origin.taskId &&
								slot.status !== "done",
						);
						if (
							!parent ||
							parent.agent !== serializeReview(agent) ||
							!parent.calls.has(origin.callId) ||
							!slot ||
							live?.run?.taskId !== parent.runId
						)
							throw new Error("No genuine pending parent call");
						const model = api.models.getModel(
							parent.observation.provider,
							parent.observation.model,
						);
						const provider = api.models.getProvider(
							parent.observation.provider,
						);
						const auth = await api.models.checkAuth(
							parent.observation.provider,
							{
								signal,
							},
						);
						if (
							!model ||
							model.api !== "openai-codex-responses" ||
							!provider?.auth.oauth?.isSubscription ||
							provider.auth.apiKey ||
							auth?.source !== "OAuth" ||
							auth.type !== "oauth" ||
							!canonicalRoute(model.baseUrl) ||
							!canonicalRoute(provider.baseUrl)
						)
							throw new Error("Unsupported reviewer auth");
						const assessment = await reviewAction({
							models: api.models,
							fetch: options.fetch ?? globalThis.fetch,
							model,
							parentThreadId: parent.observation.sessionId!,
							parentResponseId: parent.observation.responseId,
							context: parent.context,
							action: JSON.parse(exact),
							signal,
						});
						const current = await api.snapshot(
							LiveDoc,
							api.conversationId,
							context,
						);
						const session = await api.snapshot(
							ProviderDoc,
							api.conversationId,
							context,
						);
						if (
							signal.aborted ||
							version !== revision ||
							parents.get(api.conversationId) !== parent ||
							!isDeepStrictEqual(
								inherited,
								(await api.snapshot(ToolOriginDoc, api.taskId, context))
									?.origin,
							) ||
							!isDeepStrictEqual(
								agent,
								await api.snapshot(AgentDoc, api.conversationId, context),
							) ||
							current?.run?.taskId !== parent.runId ||
							!current.tools?.some(
								(slot) =>
									slot.callId === origin.callId &&
									slot.taskId === origin.taskId &&
									slot.status !== "done",
							) ||
							api.models.getProvider(parent.observation.provider) !==
								provider ||
							session?.sessionId !== parent.observation.sessionId ||
							cwd !== options.cwdForConversation?.(api.conversationId) ||
							exact !== serializeAction(action)
						)
							throw new Error("Stale review");
						last = assessment.outcome;
						if (assessment.outcome === "deny")
							return {
								block: "Guardian denied this action. Nothing executed.",
							};
					} catch {
						last = "unavailable";
						return {
							block:
								"Guardian could not authorize this action. Nothing executed. Check the policy and current text-only Codex parent.",
						};
					} finally {
						active.delete(controller);
						controller.abort();
					}
				},
			}),
		],
	});
	return {
		extension,
		observeCompletion,
		prepareRequest,
		reload,
		setEnabled(value: boolean) {
			invalidate();
			enabled = value;
		},
		status: () => ({ enabled, rules: rules.length, configError, last }),
		/** Host must call on trust, model, branch or execution-environment changes and shutdown. */
		invalidate,
		close() {
			invalidate();
			enabled = false;
		},
	};
}
