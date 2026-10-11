import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { awaitWithContext } from "@earendil-works/chord/context";
import {
	type AgentEvent,
	type AgentEventStream,
	type CompactionResult,
	type Conversation,
	type ConversationId,
	defineExtension,
	defineTask,
	type EntryId,
	type Harness,
	type TaskId,
	type TaskRuntime,
	UserEntry,
	watchEvents,
} from "@earendil-works/pi-durable";
import {
	createSettingsContribution,
	type SettingsStorage,
	settingsObject,
} from "../../../internal/settings/index.ts";
import {
	DEFAULT_GIPPITY_CONTROL_CONFIG,
	type GippityControlConfig,
	normalizeGippityControlConfig,
	REALTIME_V3_VOICES,
	VOICE_CONTEXT_REASONING_LEVELS,
} from "./config.ts";
import { deferred } from "./deferred.ts";
import type {
	AudioLease,
	GippityAppFiles,
	GippityAudioHost,
	GippityLanPermission,
	GippityPresentation,
	GippitySettingsStore,
} from "./host.ts";
import {
	changedGippityPreferences,
	mergeGippityPreferences,
	validateGippityPreferences,
} from "./preferences.ts";
import { resolveCodexVoiceAuth } from "./voice/auth.ts";
import { initialVoiceItems, summarizeVoiceContext } from "./voice/context.ts";
import { NativeCodexRealtimePeer } from "./voice/conversation/native-peer.ts";
import type { CodexRealtimePeer } from "./voice/conversation/peer.ts";
import { CodexRealtimeConversation } from "./voice/conversation/session.ts";
import { CodexDictationSession } from "./voice/dictation/session.ts";
import type {
	TransferredVoiceControls,
	VoiceHandoffChannel,
} from "./voice/handoff-contract.ts";
import { startVoiceDeparture } from "./voice/handoff-departure.ts";
import { HandoffRemotePeer } from "./voice/handoff-peer.ts";
import { isRecord, VoiceHandoffLink } from "./voice/handoff-wire.ts";
import { VoiceHelperClient, type VoiceHelperEvent } from "./voice/helper.ts";
import {
	type GippityRemoteAppProvider,
	GippityRemoteApps,
} from "./voice/lan/remote-app.ts";
import {
	type GippityLanServer,
	startGippityLanServer,
} from "./voice/lan/server.ts";
import {
	renderRealtimeDelegation,
	renderRealtimeTranscriptTail,
} from "./voice/prompts.ts";
import { completedVoiceReasoningSummary } from "./voice/reasoning-summary.ts";
import type { RealtimeVoiceTurn } from "./voice/turns.ts";

type ServiceState = { phase: "ready" } | { phase: "active" };
type ServiceRuntime = TaskRuntime<
	{ instance: string },
	ServiceState,
	null,
	object
>;

interface GippityVoiceBaseOptions {
	/** Stable unique name when installing multiple GipPity instances in one registry. */
	instanceName?: string;
	/** Capability namespace must equal the selected conversation ExecutionEnv.id. */
	namespace: string;
	audio: GippityAudioHost;
	lease: AudioLease;
	config?: unknown;
	/** Explicit instruction content, supplied by the app; no ambient prompt files. */
	instructions: string;
	allowContextSummary?: boolean;
	/** Explicit provider proxy environment. Never passed to the audio helper or browser. */
	providerEnv?: Record<string, string>;
	lan?: GippityLanPermission;
	appFiles?: GippityAppFiles;
	present?(event: GippityPresentation): void;
	/** Explicit app-owned JSON controls. No arbitrary object/property traversal. */
	rpc?(
		request: { target: string; method: string; args: unknown[] },
		signal: AbortSignal,
	): Promise<unknown>;
	/** Authorize an authenticated ordered channel; this is NOT a physical mic lease. */
	handoff?(
		request: {
			channel: VoiceHandoffChannel;
			conversationId: ConversationId;
			transport: "pcm24" | "webrtc";
		},
		signal: AbortSignal,
	): Promise<{ release(): Promise<void> }>;
}

export type GippityVoiceOptions = GippityVoiceBaseOptions &
	(
		| { settings?: GippitySettingsStore; preferences?: never }
		| {
				settings?: never;
				/** Explicit scoped persistence, mutually exclusive with the legacy settings store. */
				preferences: {
					storage: SettingsStorage;
					writeScope: "global" | "project";
				};
		  }
	);

/** Each instance owns exactly one conversation. Create another instance for another target. */
export function createGippityVoice(options: GippityVoiceOptions) {
	if (options.settings && options.preferences)
		throw new Error(
			"Choose preferences or the legacy settings store, not both",
		);
	if (
		options.instanceName !== undefined &&
		!/^[a-z0-9][a-z0-9.-]{0,63}$/.test(options.instanceName)
	)
		throw new Error("Invalid voice instance name");
	const registrationName = `howaboua.gippity-voice${options.instanceName ? `.${options.instanceName}` : ""}`;
	if (
		!options.namespace ||
		options.audio.namespace !== options.namespace ||
		!options.instructions.trim()
	)
		throw new Error(
			"Voice requires explicit audio permission, namespace, and instructions",
		);
	if (
		(options.lan && options.lan.namespace !== options.namespace) ||
		(options.appFiles && options.appFiles.namespace !== options.namespace)
	)
		throw new Error(
			"Voice host capabilities must share the conversation namespace",
		);
	const instance = randomUUID();
	const leaseOwner = `${registrationName}:${instance}`;
	let providerSessionId = randomUUID();
	let harness: Harness | undefined;
	let conversationId: ConversationId | undefined;
	let conversation: Conversation | undefined;
	let runtime: ServiceRuntime | undefined;
	let runtimeContext: Context | undefined;
	let taskId: TaskId<null> | undefined;
	let serviceStart: Promise<void> | undefined;
	let ready: ReturnType<typeof deferred<void>> | undefined;
	let config = normalizeGippityControlConfig(options.config);
	let saved = false;
	let serial = Promise.resolve();
	let configSerial = Promise.resolve();
	let startAbort: AbortController | undefined;
	let startEpoch = 0;
	let session: CodexRealtimeConversation | undefined;
	let dictation: CodexDictationSession | undefined;
	let lease: Awaited<ReturnType<AudioLease["acquire"]>> | undefined;
	let peerFactory: (() => CodexRealtimePeer) | undefined;
	let activeConfig: GippityControlConfig | undefined;
	let muted = false;
	let lan: GippityLanServer | undefined;
	let events: AgentEventStream | undefined;
	let closing = false;
	let summary: string | undefined;
	let alternateVoice = false;
	let transferring = false;
	let transferred: TransferredVoiceControls | undefined;
	let handoffGrant: { release(): Promise<void> } | undefined;
	let departureGrant: { release(): Promise<void> } | undefined;
	let handoffLink: VoiceHandoffLink | undefined;
	let departure: { completion: Promise<void>; close(): void } | undefined;
	let removeTransferEvents: (() => void) | undefined;
	let working = false;
	const remoteApps = new GippityRemoteApps();
	const listeners = new Set<(event: string, data: unknown) => void>();
	const publish = (event: GippityPresentation) => {
		options.present?.(event);
		for (const listener of listeners) listener(event.type, event);
		lan?.publish(event);
	};
	const report = (error: unknown) =>
		publish({ type: "error", message: asError(error).message });
	const settingsContribution = options.preferences
		? createSettingsContribution({
				definition: {
					id: "howaboua.gippity-voice",
					defaults: DEFAULT_GIPPITY_CONTROL_CONFIG,
					validateOverride: (value) =>
						settingsObject(validateGippityPreferences(value)),
					resolve: ({ global, project }) => {
						const next = mergeGippityPreferences(
							validateGippityPreferences(global ?? {}),
							validateGippityPreferences(project ?? {}),
						);
						if (next.voice.contextModel && !options.allowContextSummary)
							throw new Error("Context export is not authorized");
						return next;
					},
				},
				storage: options.preferences.storage,
				async apply(effective) {
					config = effective;
					saved = true;
					return {
						status: "next-use",
						message:
							"Saved. Active calls keep their settings; changes apply on next use.",
					};
				},
			})
		: undefined;
	const loadPreferences = async () => {
		if (settingsContribution && !saved) {
			const snapshot = await settingsContribution.read();
			if (!saved) {
				config = snapshot.effective;
				saved = true;
			}
		}
	};
	const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
		const result = serial.then(work);
		serial = result.then(
			() => {},
			() => {},
		);
		return result;
	};
	const changeConfig = (create: () => unknown) => {
		const result = configSerial.then(async () => {
			await loadPreferences();
			if (settingsContribution && options.preferences) {
				const next = mergeGippityPreferences(
					validateGippityPreferences(create()),
				);
				const snapshot = await settingsContribution.read();
				const scope = options.preferences.writeScope;
				const change = await settingsContribution.replaceOverride({
					scope,
					value: settingsObject(
						changedGippityPreferences(
							config,
							next,
							validateGippityPreferences(snapshot.overrides[scope] ?? {}),
						),
					),
					expectedRevision: snapshot.revision,
				});
				if (change.application.status === "failed")
					throw new Error(change.application.message);
				return structuredClone(config);
			}
			const next = normalizeGippityControlConfig(create());
			if (next.voice.contextModel && !options.allowContextSummary)
				throw new Error("Context export is not authorized");
			await options.settings?.write(next);
			config = next;
			saved = true;
			return structuredClone(config);
		});
		configSerial = result.then(
			() => {},
			() => {},
		);
		return result;
	};
	const requireRuntime = () => {
		if (!runtime || !runtimeContext || !conversation || closing)
			throw new Error("Voice service is not active");
		runtime.signal.throwIfAborted();
		return { runtime, context: runtimeContext, conversation };
	};
	const releaseLease = async () => {
		const current = lease;
		if (!current) return;
		await current.release();
		if (lease === current) lease = undefined;
	};
	const stopSession = async () => {
		const wasRealtime = Boolean(session);
		startEpoch += 1;
		startAbort?.abort();
		await session?.close();
		await dictation?.close();
		await transferred?.stop();
		transferred = undefined;
		handoffLink?.close();
		handoffLink = undefined;
		departure?.close();
		departure = undefined;
		removeTransferEvents?.();
		removeTransferEvents = undefined;
		await handoffGrant?.release();
		handoffGrant = undefined;
		await departureGrant?.release();
		departureGrant = undefined;
		session = undefined;
		dictation = undefined;
		peerFactory = undefined;
		activeConfig = undefined;
		await releaseLease();
		muted = false;
		if (wasRealtime && !runtime?.signal.aborted)
			await passive(
				"gippity.voice.lifecycle",
				{ mode: "realtime", state: "ended" },
				'<realtime_voice_session state="ended">The realtime voice session has closed. This lifecycle event carries no task. Evaluate subsequent transcript-tail context normally. Resume normal conversation, tools and formatting.</realtime_voice_session>',
			);
		publish({ type: "lifecycle", active: false });
	};
	const cleanup = async () => {
		closing = true;
		startEpoch += 1;
		startAbort?.abort();
		// Disable network admission before any provider/device teardown.
		await lan?.close();
		lan = undefined;
		await serial;
		await stopSession();
		await events?.stop();
		events = undefined;
	};
	const task = defineTask<{ instance: string }, ServiceState, null>({
		name: `${registrationName}.session`,
		version: 1,
		initial: () => ({ phase: "ready" }),
		phases: {
			async ready(_task, api, context) {
				await api.commit(
					() => ({ status: "running", checkpoint: { phase: "active" } }),
					context,
				);
			},
			async active(record, api, context) {
				// A committed intent never authorizes reopening an interrupted microphone/network call.
				const nonce = randomUUID();
				if (
					record.input.instance !== instance ||
					(await api.memo("started", nonce, context)) !== nonce
				) {
					await api.commit(
						() => ({
							status: "terminal",
							outcome: {
								status: "failed",
								error: {
									message:
										"Voice service interrupted; provider/audio outcome is uncertain. Start explicitly; no call was replayed.",
								},
							},
						}),
						context,
					);
					return;
				}
				try {
					const env = await api.env(context);
					if (env?.id !== options.namespace)
						throw new Error(
							"Audio capability does not match the conversation execution environment",
						);
					if (!harness || !conversationId)
						throw new Error("Bind voice to its Harness before starting");
					conversation = await harness.conversation(conversationId, context);
					if (!conversation)
						throw new Error("Voice conversation no longer exists");
					runtime = api;
					runtimeContext = context;
					closing = false;
					await configSerial;
					await loadPreferences();
					if (!saved && options.settings) {
						config = normalizeGippityControlConfig(
							await options.settings.read(),
						);
						saved = true;
					}
					events = await watchEvents(harness, conversationId, context);
					working = Boolean(events.snapshot.run);
					events.start(async (batch) => {
						const delegated = new Set(
							batch.flatMap((event) =>
								event.type === "submission" &&
								event.record.requestId?.startsWith("gippity:") &&
								event.record.entry !== undefined
									? [event.record.entry]
									: [],
							),
						);
						for (const event of batch) handleEvent(event, delegated);
					});
					ready?.resolve();
					await new Promise<void>((resolve) => {
						if (api.signal.aborted) resolve();
						else
							api.signal.addEventListener("abort", () => resolve(), {
								once: true,
							});
					});
				} catch (error) {
					ready?.reject(error);
					throw error;
				} finally {
					try {
						await cleanup();
					} finally {
						runtime = undefined;
						runtimeContext = undefined;
						serviceStart = undefined;
						taskId = undefined;
					}
				}
			},
		},
		async abort(_record, api, context) {
			await cleanup();
			await api.commit(
				() => ({
					status: "terminal",
					outcome: {
						status: "aborted",
						reason: "Voice stopped; no interrupted side effect replayed",
					},
				}),
				context,
			);
		},
	});
	const extension = defineExtension({
		name: registrationName,
		tasks: [task],
	});
	async function ensureService(context: Context) {
		if (runtime && !closing) return;
		if (serviceStart) return awaitWithContext(serviceStart, context);
		if (!harness || !conversationId)
			throw new Error("Bind voice to its Harness and conversation first");
		ready = deferred<void>();
		const waiting = ready;
		serviceStart = (async () => {
			taskId = await harness.commit(
				(tx) =>
					tx.createTask(
						task,
						{ instance },
						{
							conversationId: conversationId!,
							ownership: { kind: "conversation" },
							background: true,
						},
					),
				context,
			);
			harness.resume();
			void harness.waitForTask(taskId, context).then(
				(receipt) => {
					if (!runtime)
						waiting.reject(
							new Error(
								receipt.state.outcome.status === "failed" ||
									receipt.state.outcome.status === "faulted"
									? receipt.state.outcome.error.message
									: "Voice service ended before startup",
							),
						);
				},
				(error) => waiting.reject(error),
			);
			await waiting.promise;
		})().catch((error) => {
			serviceStart = undefined;
			throw error;
		});
		return awaitWithContext(serviceStart, context);
	}
	async function passive(
		kind: string,
		data: Record<string, string>,
		text?: string,
	) {
		if (!conversation || !runtimeContext) return;
		await conversation.submit(
			{
				type: "write",
				entry: {
					kind,
					data,
					...(text
						? {
								model: [{ role: "user", content: text, timestamp: Date.now() }],
							}
						: {}),
				},
			},
			runtimeContext,
		);
	}
	async function acceptTurn(turn: RealtimeVoiceTurn) {
		if (!turn.delegationId) {
			publish({ type: "transcript", role: "assistant", text: turn.input });
			await passive("gippity.voice.turn", {
				input: turn.input,
				route: "conversation",
			});
			return;
		}
		const active = session;
		const { conversation, context, runtime } = requireRuntime();
		active?.activateDelegation(turn.delegationId);
		await conversation.submit(
			{
				type: "input",
				content: renderRealtimeDelegation(turn.input, turn.transcriptDelta),
				whenBusy: "steer",
				requestId: `gippity:${runtime.taskId}:${turn.delegationId}`,
			},
			context,
		);
	}
	async function prepareSummary(signal: AbortSignal, settings = config) {
		const { runtime, conversation, context } = requireRuntime();
		if (settings.voice.contextModel && !options.allowContextSummary)
			throw new Error(
				"Context summary export requires explicit host permission",
			);
		const view = await conversation.context(context);
		const result = await summarizeVoiceContext(
			runtime.models,
			view,
			settings,
			signal,
		);
		const latest = await conversation.context(context);
		const boundary = (entries: typeof view.entries) =>
			entries.findLast(
				(entry) =>
					entry.model?.length && entry.kind !== "gippity.voice.lifecycle",
			)?.id;
		if (
			view.head?.id !== latest.head?.id ||
			boundary(view.entries) !== boundary(latest.entries)
		)
			throw new Error(
				"Conversation changed while preparing voice context; retry explicitly",
			);
		return result;
	}
	async function resolveAuth(signal: AbortSignal) {
		const { runtime } = requireRuntime();
		const auth = await resolveCodexVoiceAuth(
			runtime.models,
			providerSessionId,
			signal,
		);
		if (options.providerEnv) auth.env = { ...auth.env, ...options.providerEnv };
		return auth;
	}
	async function openVoice(
		factory: () => CodexRealtimePeer,
		signal: AbortSignal,
		settings: GippityControlConfig,
		prepared: string | undefined,
		items = initialVoiceItems(prepared),
		greeting: "start" | "arrival" | "none" = "start",
	) {
		const auth = await resolveAuth(signal);
		signal.throwIfAborted();
		const peer = factory();
		let current!: CodexRealtimeConversation;
		current = new CodexRealtimeConversation(
			{
				onStatus: (status) => publish({ type: "status", status }),
				onUserTranscript: (text) => {
					publish({ type: "transcript", role: "user", text });
					void passive("gippity.voice.user-transcript", { text }).catch(report);
				},
				onTurn: (turn) => {
					void acceptTurn(turn).catch(report);
				},
				onTranscriptTail: (text) => {
					void passive(
						"gippity.voice.tail",
						{ text },
						renderRealtimeTranscriptTail(text),
					).catch(report);
				},
				onError: (error) => {
					report(error);
					if (session === current) {
						startAbort?.abort();
						void enqueue(stopSession).catch(report);
					}
				},
				onDrop: (error) => {
					if (session !== current) return;
					report(error);
					void enqueue(async () => {
						if (session !== current) return;
						await current.close();
						session = undefined;
						if (
							!settings.voice.autoResumeRealtime ||
							signal.aborted ||
							closing
						) {
							await stopSession();
							return;
						}
						publish({ type: "status", status: "reconnecting…" });
						try {
							await openVoice(
								factory,
								signal,
								settings,
								prepared,
								items,
								"none",
							);
						} catch (failure) {
							report(failure);
							await stopSession();
						}
					}).catch(report);
				},
			},
			peer,
		);
		session = current;
		const abort = () => {
			void current.close().catch(report);
		};
		signal.addEventListener("abort", abort, { once: true });
		try {
			await current.start(auth, settings, options.instructions, items, muted);
			signal.throwIfAborted();
			if (session !== current) throw new Error("Voice startup was superseded");
			current.markEstablished();
			if (greeting !== "none")
				current.greet(Boolean(prepared), greeting === "arrival");
			if (greeting !== "none")
				await passive(
					"gippity.voice.lifecycle",
					{ mode: "realtime", state: "active" },
					'<realtime_voice_session state="active">A separate voice assistant is conversing with the user. This lifecycle event carries no task. Handle realtime_delegation as ordinary authoritative user requests. Handle typed messages normally. During longer delegated work give meaningful user-facing progress between tool calls. Shape delegated replies for concise natural spoken delivery. Include visual links, code, commands or tables only when specifically requested. Do not invoke interactive question tools unless requested. Ask necessary clarifying questions in ordinary assistant text.</realtime_voice_session>',
				);
			publish({ type: "lifecycle", active: true });
			if (prepared) {
				summary = prepared;
				publish({ type: "context", summary: prepared });
				await passive("gippity.voice.context", { summary: prepared });
			}
		} catch (error) {
			await current.close();
			if (session === current) session = undefined;
			throw error;
		} finally {
			signal.removeEventListener("abort", abort);
		}
	}
	async function startVoice(
		context: Context,
		factory: () => CodexRealtimePeer = () =>
			new NativeCodexRealtimePeer(options.audio),
		replace = false,
	) {
		const requestedEpoch = startEpoch;
		await ensureService(context);
		return enqueue(async () => {
			if (requestedEpoch !== startEpoch)
				throw new Error("Voice startup cancelled");
			if (
				dictation ||
				transferring ||
				transferred ||
				(session && !replace) ||
				(lease && !session)
			)
				throw new Error("Voice or dictation is already active");
			const previous = session;
			const { runtime } = requireRuntime();
			startAbort = new AbortController();
			const signal = AbortSignal.any([
				runtime.signal,
				startAbort.signal,
				...(context.abortSignal ? [context.abortSignal] : []),
			]);
			lease ??= await options.lease.acquire(
				{ owner: `${leaseOwner}:${runtime.conversationId}`, mode: "voice" },
				signal,
			);
			try {
				await configSerial;
				const settings = structuredClone(config);
				alternateVoice = false;
				const prepared = await prepareSummary(signal, settings);
				if (previous) {
					await previous.close();
					if (session === previous) session = undefined;
				}
				peerFactory = factory;
				activeConfig = settings;
				await openVoice(factory, signal, settings, prepared);
			} catch (error) {
				await stopSession();
				throw error;
			}
		});
	}
	async function refreshContext() {
		if (!session || !peerFactory || !activeConfig || !startAbort || !runtime)
			return;
		const previous = session;
		const factory = peerFactory;
		const settings = activeConfig;
		if (!settings.voice.contextModel) {
			report(
				new Error(
					"Post-compaction voice refresh needs a context model; keeping the current call",
				),
			);
			return;
		}
		const signal = AbortSignal.any([runtime.signal, startAbort.signal]);
		// Summarization failure leaves the established call intact.
		const prepared = await prepareSummary(signal, settings);
		if (!prepared || session !== previous || signal.aborted) return;
		await previous.close();
		session = undefined;
		try {
			await openVoice(
				factory,
				signal,
				settings,
				prepared,
				initialVoiceItems(prepared),
				"none",
			);
		} catch (error) {
			await stopSession();
			throw error;
		}
	}
	function handleEvent(event: AgentEvent, delegated: ReadonlySet<EntryId>) {
		if (transferred) return;
		const notification =
			event.type === "snapshot"
				? {
						type: "snapshot",
						working: Boolean(event.run),
						model: event.agent.model ?? null,
					}
				: event;
		for (const listener of listeners) listener(event.type, notification);
		lan?.agentEvent(event);
		if (event.type === "snapshot") working = Boolean(event.run);
		if (event.type === "run_start") working = true;
		if (event.type === "run_end") working = false;
		if (event.type === "run_start") session?.resumeAgentWork();
		if (event.type === "run_end") session?.settleAgentTurn();
		if (event.type === "message_update")
			for (const change of event.changes)
				if (change.type === "text_delta")
					session?.streamAgentDelta(change.delta);
				else if (
					change.type === "thinking_start" ||
					change.type === "toolcall_start"
				)
					session?.resumeAgentWork();
		if (event.type === "message_end")
			for (const message of event.entry.model ?? []) {
				if (
					message.role === "user" &&
					UserEntry.is(event.entry) &&
					!delegated.has(event.entry.id)
				) {
					const text =
						typeof message.content === "string"
							? message.content
							: message.content
									.flatMap((part) => (part.type === "text" ? [part.text] : []))
									.join("\n");
					session?.piInput(text, working ? "steer" : undefined);
					session?.piUserMessage(message);
				}
				if (message.role !== "assistant") continue;
				const text = message.content
					.flatMap((part) => (part.type === "text" ? [part.text] : []))
					.join("\n");
				if (message.stopReason === "toolUse") {
					const progress = text.trim()
						? text
						: activeConfig?.voice.forwardReasoningSummaries
							? completedVoiceReasoningSummary(message)
							: undefined;
					if (progress) session?.agentProgress(progress);
				} else session?.agentResult(text);
			}
		if (event.type === "compaction_start" && event.reason !== "manual")
			session?.announceCompactionStart(
				event.reason === "overflow" ? "overflow" : "threshold",
			);
		if (
			event.type === "compaction_end" &&
			activeConfig?.voice.refreshRealtimeAfterCompaction &&
			runtime &&
			runtimeContext
		) {
			void runtime
				.waitForTask(event.taskId as TaskId<CompactionResult>, runtimeContext)
				.then(async (receipt) => {
					if (receipt.state.outcome.status !== "completed") return;
					const result = receipt.state.outcome.result;
					if (result.submissionId !== undefined && harness && runtimeContext) {
						const submission = await harness.submission(
							result.submissionId,
							runtimeContext,
						);
						if (
							!submission ||
							(await submission.wait(runtimeContext)).status !== "done"
						)
							return;
					} else if (result.entryId === undefined) return;
					return enqueue(refreshContext);
				})
				.catch(report);
		}
	}
	const controls = {
		settingsContribution,
		bindHarness(value: Harness, target: ConversationId) {
			if (taskId || runtime || serviceStart)
				throw new Error("Stop voice before switching conversation");
			if (harness !== value || conversationId !== target)
				providerSessionId = randomUUID();
			harness = value;
			conversationId = target;
		},
		startVoice,
		async stopVoice() {
			startEpoch += 1;
			startAbort?.abort();
			await enqueue(stopSession);
		},
		get inputMuted() {
			return transferred?.inputMuted ?? muted;
		},
		setInputMuted(value: boolean) {
			if (transferred) transferred.setInputMuted(value);
			else {
				if (!session) throw new Error("Realtime voice is not active");
				session.setInputMuted(value);
			}
			muted = value;
			publish({ type: "status", status: value ? "muted" : "listening" });
			lan?.broadcast({ type: "mute", muted });
		},
		get active() {
			return Boolean(session || dictation || transferred);
		},
		async startDictation(context: Context) {
			const requestedEpoch = startEpoch;
			await ensureService(context);
			await enqueue(async () => {
				if (requestedEpoch !== startEpoch)
					throw new Error("Dictation startup cancelled");
				if (session || dictation || lease || transferring || transferred)
					throw new Error("Voice or dictation is already active");
				const { runtime } = requireRuntime();
				startAbort = new AbortController();
				const signal = AbortSignal.any([
					runtime.signal,
					startAbort.signal,
					...(context.abortSignal ? [context.abortSignal] : []),
				]);
				lease = await options.lease.acquire(
					{
						owner: `${leaseOwner}:${runtime.conversationId}`,
						mode: "dictation",
					},
					signal,
				);
				try {
					const auth = await resolveAuth(signal);
					dictation = new CodexDictationSession(
						{
							onStatus: (status) => publish({ type: "status", status }),
							onTranscript: (text) => publish({ type: "draft", text }),
							onError: (error) => {
								report(error);
								startAbort?.abort();
								void enqueue(stopSession).catch(report);
							},
						},
						options.audio,
					);
					const current = dictation;
					const abort = () => {
						void current.close().catch(report);
					};
					signal.addEventListener("abort", abort, { once: true });
					try {
						await current.start(auth, structuredClone(config));
						signal.throwIfAborted();
					} finally {
						signal.removeEventListener("abort", abort);
					}
					publish({ type: "lifecycle", active: true });
				} catch (error) {
					await stopSession();
					throw error;
				}
			});
		},
		async finishDictation() {
			await enqueue(async () => {
				await dictation?.finish();
				await stopSession();
			});
		},
		async sendText(text: string, context: Context) {
			await ensureService(context);
			if (!text.trim() || Buffer.byteLength(text) > 64 * 1024)
				throw new Error("Message is empty or oversized");
			if (transferred) return transferred.sendText(text);
			const current = requireRuntime();
			await current.conversation.submit(
				{
					type: "input",
					content: text,
					whenBusy: "steer",
					requestId: randomUUID(),
				},
				context,
			);
		},
		async rpc(body: Record<string, unknown>) {
			if (transferred) return transferred.rpc(body);
			if (
				!options.rpc ||
				typeof body["target"] !== "string" ||
				typeof body["method"] !== "string" ||
				!Array.isArray(body["args"])
			)
				throw new Error("Application control unavailable or invalid");
			return options.rpc(
				{ target: body["target"], method: body["method"], args: body["args"] },
				requireRuntime().runtime.signal,
			);
		},
		getConfig() {
			return structuredClone(config);
		},
		registerRemoteApp(provider: GippityRemoteAppProvider) {
			if (!options.appFiles)
				throw new Error("Remote apps require app-files permission");
			return remoteApps.register(provider);
		},
		async configure(value: unknown) {
			return changeConfig(() => value);
		},
		async configureVoice(patch: Partial<GippityControlConfig["voice"]>) {
			return changeConfig(() => ({
				...config,
				voice: {
					...config.voice,
					...(options.preferences
						? Object.fromEntries(
								Object.entries(patch).map(([key, value]) => [
									key,
									value === undefined ? null : value,
								]),
							)
						: patch),
				},
			}));
		},
		async settings(context: Context) {
			await ensureService(context);
			const available = await requireRuntime().runtime.models.getAvailable(
				undefined,
				{ signal: runtime!.signal },
			);
			return {
				config: {
					...config.voice,
					contextModel: config.voice.contextModel ?? null,
				},
				voices: REALTIME_V3_VOICES,
				contextReasoningLevels: VOICE_CONTEXT_REASONING_LEVELS,
				contextModels: available.map((model) => ({
					provider: model.provider,
					modelId: model.id,
				})),
				scope: options.preferences
					? options.preferences.writeScope
					: options.settings
						? "application settings store"
						: "this component instance",
			};
		},
		async listDevices(context: Context) {
			await ensureService(context);
			return enqueue(async () => {
				const { runtime } = requireRuntime();
				const token = await options.lease.acquire(
					{
						owner: `${leaseOwner}:${runtime.conversationId}:devices`,
						mode: "voice",
					},
					runtime.signal,
				);
				const helper = new VoiceHelperClient(options.audio);
				try {
					await helper.start();
					return await new Promise<
						Extract<VoiceHelperEvent, { type: "devices" }>
					>((resolve, reject) => {
						const timer = setTimeout(() => {
							remove();
							removeExit();
							reject(new Error("Device enumeration timed out"));
						}, 5_000);
						const remove = helper.onEvent((event) => {
							if (event.type === "devices") {
								clearTimeout(timer);
								remove();
								removeExit();
								resolve(event);
							}
						});
						const removeExit = helper.onExit((error) => {
							clearTimeout(timer);
							remove();
							removeExit();
							reject(error);
						});
						helper.send({ type: "list_devices" });
					});
				} finally {
					await helper.close();
					await token.release();
				}
			});
		},
		async startLan(context: Context) {
			await ensureService(context);
			if (!options.lan)
				throw new Error("HTTPS LAN permission was not supplied");
			await enqueue(async () => {
				if (!lan) {
					lan = await startGippityLanServer({
						permission: options.lan!,
						audio: options.audio,
						appFiles: options.appFiles,
						lease: options.lease,
						owner: `${leaseOwner}:${conversationId}`,
						signal: runtime!.signal,
						controls,
						context: runtimeContext!,
						resolveAuth: () => resolveAuth(runtime!.signal),
						remoteApps,
					});
					if (events) lan.agentEvent(events.snapshot);
				}
			});
			return lan!.urls;
		},
		async stopLan() {
			const current = lan;
			lan = undefined;
			await current?.close();
		},
		onSessionEvent(listener: (event: string, data: unknown) => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		/** The consuming approval UI owns prompt start/end, which Durable does not emit. */
		activityWaiting(text?: string) {
			publish({
				type: "activity",
				state: "waiting",
				...(text ? { text } : {}),
			});
		},
		activityPromptEnded() {
			publish({ type: "activity", state: working ? "working" : "idle" });
		},
		async close(context: Context) {
			startEpoch += 1;
			startAbort?.abort();
			await controls.stopLan();
			const id = taskId;
			if (harness && id) {
				await harness.abortTask(id, context);
				const receipt = await harness.waitForTask(id, context);
				if (
					receipt.state.outcome.status !== "aborted" &&
					receipt.state.outcome.status !== "completed"
				)
					throw new Error(
						"Voice cleanup failed or was interrupted; audio outcome is uncertain",
					);
			} else await cleanup();
			remoteApps.close();
		},
		get summary() {
			return summary;
		},
		/** Source owns physical audio throughout the transfer. No microphone release/reacquire race. */
		async depart(
			channel: VoiceHandoffChannel,
			context: Context,
			transport: "pcm24" | "webrtc" = "webrtc",
		) {
			if (transport !== "webrtc")
				throw new Error(
					"GipPity handoff requires WebRTC; PCM conversion is not available",
				);
			if (
				!options.handoff ||
				transferring ||
				transferred ||
				!session ||
				!peerFactory ||
				!activeConfig ||
				(!lease && (!handoffLink || !handoffGrant))
			)
				throw new Error("Source voice is not available for authorized handoff");
			transferring = true;
			const source = session;
			const factory = peerFactory;
			const settings = activeConfig;
			try {
				const { runtime, conversation } = requireRuntime();
				const signal = AbortSignal.any([
					runtime.signal,
					...(context.abortSignal ? [context.abortSignal] : []),
				]);
				departureGrant = await options.handoff(
					{ channel, conversationId: runtime.conversationId, transport },
					signal,
				);
				departure = startVoiceDeparture({
					signal,
					channel,
					captured: {
						inputMuted: muted,
						alternateVoice,
						sourceActive: () => session === source,
						bindControls: () => {},
						async release(signal) {
							signal.throwIfAborted();
							await source.close();
							signal.throwIfAborted();
							if (session === source) session = undefined;
							await passive(
								"gippity.voice.lifecycle",
								{ mode: "realtime", state: "ended", reason: "handoff" },
								'<realtime_voice_session state="ended">Voice has moved to another Durable conversation. This lifecycle event carries no task. Resume ordinary conversation and formatting here.</realtime_voice_session>',
							);
						},
						async createPeer() {
							return factory();
						},
						start: (peer) => peer.start(settings),
						transferred(_peer, value) {
							transferred = value;
							removeTransferEvents?.();
							removeTransferEvents = value.onSessionEvent((event, data) => {
								for (const listener of listeners) listener(event, data);
								if (handoffLink && !handoffLink.closed)
									handoffLink.notify({ type: "session.event", event, data });
								lan?.sessionEvent(event, data);
							});
						},
						async finished(_peer, error) {
							transferred = undefined;
							removeTransferEvents?.();
							removeTransferEvents = undefined;
							if (session !== source) {
								handoffLink?.close();
								handoffLink = undefined;
								await handoffGrant?.release();
								handoffGrant = undefined;
								await releaseLease();
								publish({ type: "lifecycle", active: false });
							}
							await departureGrant?.release();
							departureGrant = undefined;
							report(error);
						},
					},
					async waitForSettled(signal) {
						await awaitWithContext(conversation.waitForIdle(context), context);
						signal.throwIfAborted();
						await source.waitForPlaybackEnd(signal);
					},
					onReleased(value) {
						transferred = value;
					},
					onClosed: report,
				});
				await departure.completion;
			} catch (error) {
				if (session === source) {
					await departureGrant?.release();
					departureGrant = undefined;
				}
				throw error;
			} finally {
				transferring = false;
			}
		},
		/** Destination gets a channel grant, never the source microphone's lease. */
		async arrive(
			channel: VoiceHandoffChannel,
			continuity: string,
			context: Context,
			transport: "pcm24" | "webrtc" = "webrtc",
		) {
			if (transport !== "webrtc")
				throw new Error(
					"GipPity handoff requires WebRTC; PCM conversion is not available",
				);
			if (!options.handoff || transferring || controls.active || lease)
				throw new Error("Destination voice is busy or handoff is unauthorized");
			if (Buffer.byteLength(continuity) > 64 * 1024)
				throw new Error("Voice handoff continuity is oversized");
			transferring = true;
			let remote: HandoffRemotePeer | undefined;
			let removeStartupAbort: (() => void) | undefined;
			try {
				await ensureService(context);
				const { runtime } = requireRuntime();
				startAbort = new AbortController();
				const signal = AbortSignal.any([
					runtime.signal,
					startAbort.signal,
					...(context.abortSignal ? [context.abortSignal] : []),
				]);
				handoffGrant = await options.handoff(
					{ channel, conversationId: runtime.conversationId, transport },
					signal,
				);
				const prepared = await prepareSummary(signal);
				await resolveAuth(signal);
				const link = new VoiceHandoffLink(channel, {
					async request(method, value) {
						if (method === "session.send" && typeof value === "string")
							return controls.sendText(value, context);
						if (method === "session.rpc" && isRecord(value))
							return controls.rpc(value);
						throw new Error("Invalid destination voice control");
					},
					notification(message) {
						if (message.type === "peer.event")
							remote?.receive(message.generation, message.event);
						else if (message.type === "session.mute") {
							if (session || transferred) controls.setInputMuted(message.muted);
							else muted = message.muted;
						} else throw new Error("Invalid destination voice notification");
					},
					closed(error) {
						startAbort?.abort();
						remote?.disconnected(error);
						report(error);
						void enqueue(stopSession).catch(report);
					},
				});
				handoffLink = link;
				const cancelled = () => link.fail(new Error("Voice arrival cancelled"));
				signal.addEventListener("abort", cancelled, { once: true });
				removeStartupAbort = () =>
					signal.removeEventListener("abort", cancelled);
				signal.throwIfAborted();
				link.stage("prepared");
				const activation = await link.waitFor("activate");
				if (
					!isRecord(activation) ||
					typeof activation["inputMuted"] !== "boolean" ||
					(activation["alternateVoice"] !== undefined &&
						typeof activation["alternateVoice"] !== "boolean")
				)
					throw new Error("Invalid handoff microphone or voice selection");
				signal.throwIfAborted();
				muted = activation["inputMuted"];
				alternateVoice = activation["alternateVoice"] === true;
				const settings = structuredClone(config);
				if (alternateVoice)
					settings.voice.v3Voice = settings.voice.v3AlternateVoice;
				const factory = () => {
					remote = new HandoffRemotePeer(link);
					return remote;
				};
				peerFactory = factory;
				activeConfig = settings;
				const items = [
					...(initialVoiceItems(prepared) ?? []),
					{
						type: "message" as const,
						role: "developer" as const,
						content: [
							{
								type: "input_text" as const,
								text: `The user is joining this Durable conversation by voice. Arrival history, not a new task:\n${continuity}`,
							},
						],
					},
				];
				await enqueue(() =>
					openVoice(factory, signal, settings, prepared, items, "arrival"),
				);
				removeTransferEvents = controls.onSessionEvent((event, data) => {
					if (!link.closed) link.notify({ type: "session.event", event, data });
				});
				link.stage("active");
				link.notify({
					type: "session.event",
					event: "binding",
					data: {
						conversationId: runtime.conversationId,
						model: events?.snapshot.agent.model ?? null,
					},
				});
				link.notify({
					type: "session.event",
					event: working ? "run_start" : "run_end",
					data: {},
				});
			} catch (error) {
				// Preparation can fail before a link exists. Wake the source immediately,
				// without exposing credential-resolution errors over the channel.
				try {
					channel.close();
				} finally {
					await enqueue(stopSession);
				}
				throw error;
			} finally {
				removeStartupAbort?.();
				transferring = false;
			}
		},
	};
	return { extension, controls, settingsContribution };
}

export type GippityVoiceControls = ReturnType<
	typeof createGippityVoice
>["controls"];
function asError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}
