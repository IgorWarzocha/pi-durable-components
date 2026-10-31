import { type Context, type JsonValue } from "@earendil-works/chord";
import {
	awaitWithContext,
	BACKGROUND_CONTEXT,
	withAbortSignal,
} from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
	type ConversationId,
	defineExtension,
	defineTask,
	type Harness,
	type TaskId,
	watchEvents,
} from "@earendil-works/pi-durable";
import { createSettingsContribution } from "../../../internal/settings/index.ts";
import { createNestedToolTask } from "../../execution/src/nested.ts";
import type { RealtimeAudio } from "./audio.ts";
import {
	DEFAULT_CONFIG,
	MODELS,
	normalizeConfig,
	SPEEDS,
	VOICES,
} from "./config.ts";
import { createContextPreparer, type VoiceRuntime } from "./context.ts";
import { VoiceCall } from "./controller.ts";
import { type Deferred, deferred } from "./deferred.ts";
import { GrokDictationController } from "./dictation.ts";
import { HandoffAudio } from "./handoff-audio.ts";
import type {
	CapturedHandoff,
	TransferredVoiceControls,
	VoiceHandoffChannel,
} from "./handoff-contract.ts";
import { startVoiceDeparture } from "./handoff-departure.ts";
import { asError, isRecord, VoiceHandoffLink } from "./handoff-wire.ts";
import type { GrokHostCapabilities, GrokVoiceOptions } from "./host.ts";
import { startLan as openLan } from "./lan/server.ts";
import { DEFAULT_THEME } from "./lan/theme.ts";
import { grokSettingsDefinition } from "./preferences.ts";
import { appendVoiceInstructions } from "./prompt.ts";
import { RetainedVoiceCall } from "./retained-call.ts";
import { SwitchableAudio } from "./switchable-audio.ts";

export type { DictationReadiness } from "../../../internal/buffered-dictation.ts";
export { listAudioDevices } from "./audio/devices.ts";
export { audioHelperUrl, type NativeAudioProcess } from "./audio/helper.ts";
export { NativeAudio } from "./audio/native.ts";
export type { RealtimeAudio } from "./audio.ts";
export {
	checkGrokDictationReadiness,
	type GrokBufferedDictationRequest,
	type GrokDictationCredentials,
	transcribeGrokDictation,
} from "./buffered-dictation.ts";
export {
	CONTEXT_REASONING,
	DEFAULT_CONFIG,
	type GrokRealtimeConfig,
	MODELS,
	normalizeConfig,
	SPEEDS,
	VOICES,
} from "./config.ts";
export type {
	TransferredVoiceControls,
	VoiceHandoffChannel,
} from "./handoff-contract.ts";
export type {
	AudioLease,
	GrokHostCapabilities,
	GrokVoiceOptions,
} from "./host.ts";
export type { LanVoiceWebTheme } from "./lan/theme.ts";

type Result = { status: string };
type Checkpoint = { phase: "run"; entered: boolean };
type Input = { requestId: string; mode: "voice" | "dictation" };
type Request = {
	harness: Harness;
	conversationId: ConversationId;
	id: TaskId<Result> | undefined;
	audio?: RealtimeAudio;
	ready: Deferred<void>;
	closed: Deferred<void>;
	ended: Deferred<void>;
	binding?: RetainedVoiceCall;
	cleanup?: () => Promise<void>;
	ownedAudio?: SwitchableAudio;
	transferred?: TransferredVoiceControls;
	alternateVoice?: boolean;
	arrival?: { channel: VoiceHandoffChannel; continuity: string };
	arrivalLink?: VoiceHandoffLink;
	departure?: { close(): void };
	created: Deferred<TaskId<Result>>;
	started?: boolean;
	/** A return arrival reuses this service's still-owned physical audio. */
	sourceOwner?: Request;
	stopCall?: () => Promise<void>;
	startCall?: () => Promise<void>;
	draft?: Promise<void>;
};

/** One component instance owns one live voice/dictation and one optional LAN listener. */
export function createGrokVoice(options: GrokVoiceOptions) {
	if (options.preferences && options.settings)
		throw new Error("Grok preferences and settings are mutually exclusive");
	if (
		options.instanceName !== undefined &&
		!/^[a-zA-Z0-9._-]{1,64}$/.test(options.instanceName)
	)
		throw new Error("Invalid Grok instanceName");
	const name = `howaboua.grok-voice${options.instanceName ? `.${options.instanceName}` : ""}`;
	const toolTask = createNestedToolTask(`${name}.tool`);
	let config = normalizeConfig(options.config ?? {}, DEFAULT_CONFIG);
	let preferencesGeneration = 0;
	const settingsContribution = options.preferences
		? createSettingsContribution({
				definition: grokSettingsDefinition,
				storage: options.preferences.storage,
				async apply(effective) {
					preferencesGeneration++;
					config = effective;
					publish();
					return { status: "next-use" };
				},
			})
		: undefined;
	async function refreshSettings() {
		if (settingsContribution) {
			const generation = preferencesGeneration;
			const snapshot = await settingsContribution.read();
			// A read started before a completed save must not undo its application.
			if (generation === preferencesGeneration) config = snapshot.effective;
		} else if (options.settings)
			config = normalizeConfig(await options.settings.load(), config);
	}
	const prepareContext = createContextPreparer(
		options.allowContext === true,
		options.projectContext,
	);
	const requests = new Map<string, Request>();
	const lanRequests = new Map<string, Request>();
	const cleanupFailures = new Map<string, Error>();
	let active: Request | undefined;
	let listener: Request | undefined;
	let lan: Awaited<ReturnType<typeof openLan>> | undefined;
	let operation = Promise.resolve();
	let settingsOperation = Promise.resolve();
	let pendingStarts = 0;
	let departing = false;
	let generation = 0;
	const dictation = new GrokDictationController(options.socket);
	const view = {
		status: "idle",
		muted: false,
		piBusy: false,
		activity: {
			status: "idle" as "idle" | "working" | "waiting" | "settled",
			text: "",
		},
	};
	const state = () => ({
		...view,
		activity: { ...view.activity },
		dictation: dictation.state(),
	});
	const present = (type: string, details: Record<string, unknown> = {}) => {
		try {
			options.present?.({ type, ...details });
		} catch (error) {
			options.report?.(error);
		}
		if (
			active?.arrivalLink &&
			!active.arrivalLink.closed &&
			!active.transferred
		)
			active.arrivalLink.notify({
				type: "session.event",
				event: type,
				data: details,
			});
	};
	const publish = () => {
		present("state", state());
		lan?.publish();
	};
	dictation.onChange = () => {
		publish();
		const status = dictation.state();
		if (active && (status.status === "done" || status.status === "error"))
			void deliverDraft(active, status.text).catch((error) => {
				options.report?.(error);
				present("draft_error", { message: asError(error).message });
			});
		if (status.status === "error")
			active?.ended.reject(new Error(status.error));
		else if (status.status === "done") active?.ended.resolve();
	};
	function deliverDraft(request: Request, text: string): Promise<void> {
		// Browser dictation stays in the browser; the host editor receives local dictation once.
		if (request.audio || !text.trim()) return Promise.resolve();
		request.draft ??= Promise.resolve().then(() => options.draft?.(text));
		return request.draft;
	}
	const setStatus = (status: string) => {
		view.status = status;
		publish();
	};
	const activity = (working: boolean, text?: string) => {
		view.piBusy = working;
		view.activity.status = working ? "working" : "settled";
		if (text !== undefined) view.activity.text = text;
		publish();
	};
	async function capabilities(
		runtime: VoiceRuntime,
		context: Context,
	): Promise<GrokHostCapabilities> {
		const environment = await runtime.env(context);
		const grant = options.capabilities(environment);
		if (!environment || !grant || grant.environmentId !== environment.id)
			throw new Error(
				"Grok host capabilities must explicitly own the conversation's execution namespace",
			);
		return grant;
	}
	function writer(runtime: VoiceRuntime, context: Context) {
		let queue = Promise.resolve();
		return {
			append(kind: string, data: JsonValue) {
				// Provider diagnostics describe the JSON wire; omit optional undefined fields just as that wire does.
				const serialized = JSON.parse(JSON.stringify(data)) as JsonValue;
				present(kind, { data: serialized });
				queue = queue
					.then(() =>
						runtime.commit(async (tx) => {
							await tx.appendEntry(runtime.conversationId, {
								kind,
								data: serialized,
							});
						}, context),
					)
					.catch((error) => {
						if (!runtime.signal.aborted) runtime.report(error);
					});
			},
			flush: () => queue,
		};
	}
	const service = defineTask<Input, Checkpoint, Result, Record<string, never>>({
		name: `${name}.service`,
		version: 1,
		initial: () => ({ phase: "run", entered: false }),
		phases: {
			run: async (task, runtime, context) => {
				const request = requests.get(task.input.requestId);
				if (task.state.checkpoint.entered || !request) {
					await runtime.commit(
						() => ({
							status: "terminal",
							outcome: {
								status: "failed",
								error: {
									message:
										"Interrupted Grok session outcome is uncertain; audio and provider sockets cannot survive restart. Start explicitly; no side effect was replayed.",
								},
							},
						}),
						context,
					);
					return;
				}
				// Persist intent before auth, context export, microphone or provider side effects.
				await runtime.commit(
					() => ({
						status: "running",
						checkpoint: { phase: "run", entered: true },
					}),
					context,
				);
				const write = writer(runtime, context);
				let lease:
					| Awaited<ReturnType<GrokVoiceOptions["lease"]["acquire"]>>
					| undefined;
				let audio: RealtimeAudio | undefined;
				let failure: unknown;
				let cleanupError: Error | undefined;
				let clean = false;
				try {
					const grant = await capabilities(runtime, context);
					await refreshSettings();
					if (request.arrival) {
						if (!grant.handoff)
							throw new Error(
								"Authenticated handoff capability was not granted",
							);
						lease = await grant.handoff(
							{
								channel: request.arrival.channel,
								conversationId: runtime.conversationId,
								transport: "pcm24",
							},
							runtime.signal,
						);
						request.arrivalLink = new VoiceHandoffLink(
							request.arrival.channel,
							{
								async request(method, value) {
									if (method === "session.stop") {
										if (request.transferred)
											return request.transferred.stopCall();
										if (!request.stopCall)
											throw new Error(
												"Selected-session voice is still connecting",
											);
										return request.stopCall();
									}
									if (method === "session.start") {
										if (request.transferred)
											return request.transferred.startCall();
										if (!request.startCall)
											throw new Error(
												"Selected-session voice is still connecting",
											);
										return request.startCall();
									}
									if (
										method === "session.send" &&
										typeof value === "string" &&
										value.trim()
									) {
										if (request.transferred)
											return request.transferred.sendText(value);
										if (
											!request.binding?.call ||
											view.status === "summarizing" ||
											view.status === "connecting"
										)
											throw new Error(
												"Selected conversation voice is still connecting",
											);
										return request.binding?.call.send(
											value,
											`grok:handoff:${crypto.randomUUID()}`,
										);
									}
									if (
										method === "session.rpc" &&
										request.transferred &&
										isRecord(value)
									)
										return request.transferred.rpc(value);
									throw new Error(
										"Selected conversation does not support this voice control",
									);
								},
								notification(message) {
									if (message.type === "audio.input")
										(request.audio as HandoffAudio).receive(message);
									else if (message.type === "session.mute") {
										view.muted = message.muted;
										if (request.transferred)
											request.transferred.setInputMuted(message.muted);
										else if (request.started)
											request.binding?.call?.mute(message.muted);
										publish();
									} else
										throw new Error("Invalid destination voice notification");
								},
								closed(error) {
									request.ended.reject(error);
									void abortRequest(request).catch((failure) =>
										runtime.report(failure),
									);
								},
							},
						);
						request.audio = new HandoffAudio(request.arrivalLink);
					} else
						lease = await options.lease.acquire(
							{
								owner: `grok:${runtime.conversationId}:${runtime.taskId}`,
								mode: task.input.mode,
							},
							runtime.signal,
						);
					runtime.signal.throwIfAborted();
					audio = new SwitchableAudio(request.audio ?? grant.audio(config));
					request.ownedAudio = audio as SwitchableAudio;
					request.cleanup = async () => {
						audio?.disconnect?.();
						request.departure?.close();
						if (request.transferred) await request.transferred.stop();
						else if (request.binding) await request.binding.shutdown();
						else if (task.input.mode === "dictation") {
							if (dictation.state().status === "done")
								await dictation.shutdown();
							else await dictation.cancel();
						} else await audio?.close();
						if (request.started && request.sourceOwner)
							await abortRequest(request.sourceOwner);
					};
					if (task.input.mode === "dictation") {
						setStatus("dictating");
						await dictation.start(
							runtime.models,
							config,
							audio,
							runtime.signal,
						);
					} else {
						const environment = await runtime.env(context);
						const userInstructions = await options.prompt?.(
							environment,
							runtime.signal,
						);
						const projectInstructions = await options.projectPrompt?.(
							environment,
							runtime.signal,
						);
						const instructions = appendVoiceInstructions(
							userInstructions,
							projectInstructions,
						);
						const createCall = (callSignal: AbortSignal) => {
							const callContext = withAbortSignal(callSignal, context);
							const callConfig = { ...config };
							return new VoiceCall({
								runtime,
								signal: callSignal,
								context: callContext,
								harness: request.harness,
								audio: audio!,
								config: callConfig,
								instructions,
								toolTask,
								prepareContext: async () => {
									const summary = await prepareContext(
										runtime,
										callConfig,
										callContext,
										callSignal,
									);
									return request.arrival
										? `${summary}\nThe caller is joining this conversation by voice. Arrival context only, not an agent task:\n${request.arrival.continuity}`
										: summary;
								},
								append: write.append,
								status: setStatus,
								activity,
								...(options.socket ? { socket: options.socket } : {}),
								failed: (error) => {
									if (!request.arrivalLink) request.ended.reject(error);
									else {
										present("error", { message: error.message });
										void request
											.stopCall?.()
											.catch((failure) => runtime.report(failure));
									}
								},
								ended: () => {
									void (
										request.arrivalLink
											? request.stopCall!()
											: abortRequest(request)
									).catch((error) => request.ended.reject(error));
								},
							});
						};
						const binding = new RetainedVoiceCall({
							signal: runtime.signal,
							create: createCall,
							reload: refreshSettings,
							activate: async (call) => {
								const prepared = await call.prepare();
								await call.activate(prepared, {
									inputMuted: view.muted,
									alternateVoice: request.alternateVoice ?? false,
								});
								request.audio?.resumeCall?.();
							},
							beforeStop: () => request.audio?.stopCall?.(),
							onStopped: () => setStatus("idle"),
						});
						request.binding = binding;
						request.stopCall = () => binding.stop();
						request.startCall = () => binding.start();
						await binding.initial(async (call) => {
							if (request.arrivalLink) {
								const prepared = await call.prepare();
								request.arrivalLink.stage("prepared");
								const activation = await awaitWithContext(
									request.arrivalLink.waitFor("activate"),
									context,
								);
								if (
									!isRecord(activation) ||
									typeof activation["inputMuted"] !== "boolean" ||
									typeof activation["alternateVoice"] !== "boolean"
								)
									throw new Error(
										"Voice transfer did not provide microphone and voice phase",
									);
								request.alternateVoice = activation["alternateVoice"];
								view.muted = activation["inputMuted"];
								if (!binding.stopped)
									await call.activate(prepared, {
										inputMuted: view.muted,
										alternateVoice: request.alternateVoice,
									});
								request.arrivalLink.stage("active");
							} else await call.start();
						});
						if (request.arrivalLink && binding.stopped)
							request.arrivalLink.stage("active");
					}
					request.started = true;
					request.ready.resolve();
					await awaitWithContext(request.ended.promise, context);
				} catch (error) {
					failure = error;
					request.ready.reject(error);
				} finally {
					try {
						await request.cleanup?.();
						request.arrivalLink?.close();
						await write.flush();
						clean = true;
					} catch (error) {
						cleanupError = new Error(
							"Grok audio teardown failed; ownership retained until the host confirms cleanup",
							{ cause: error },
						);
						failure = cleanupError;
						runtime.report(error);
					}
					if (clean) {
						try {
							await lease?.release();
						} catch (error) {
							cleanupError = new Error(
								"Grok microphone lease release failed; ownership is uncertain",
								{ cause: error },
							);
							failure = cleanupError;
							runtime.report(error);
						}
					} else if (lease)
						runtime.report(
							new Error(
								"Grok audio teardown failed; microphone lease retained until host confirms cleanup",
							),
						);
					requests.delete(task.input.requestId);
					if (cleanupError)
						cleanupFailures.set(task.input.requestId, cleanupError);
					if (active === request) {
						active = undefined;
						view.muted = false;
						if (cleanupError) {
							view.activity.status = "waiting";
							view.activity.text = cleanupError.message;
						}
						setStatus(cleanupError ? "cleanup_failed" : "idle");
					}
					if (cleanupError) request.closed.reject(cleanupError);
					else request.closed.resolve();
				}
				if (runtime.signal.aborted) throw runtime.signal.reason;
				await runtime.commit(
					() => ({
						status: "terminal",
						outcome:
							failure === undefined
								? { status: "completed", result: { status: "stopped" } }
								: { status: "failed", error: { message: String(failure) } },
					}),
					context,
				);
				cleanupFailures.delete(task.input.requestId);
			},
		},
		abort: async (task, runtime, context) => {
			const cleanupError = cleanupFailures.get(task.input.requestId);
			cleanupFailures.delete(task.input.requestId);
			const request = requests.get(task.input.requestId);
			if (request) {
				request.ready.reject(new Error("Grok startup cancelled"));
				await request.cleanup?.();
				request.closed.resolve();
				requests.delete(task.input.requestId);
				if (active === request) {
					active = undefined;
					setStatus("idle");
				}
			}
			await runtime.commit(
				() => ({
					status: "terminal",
					outcome: {
						status: "aborted",
						reason:
							cleanupError?.message ??
							"Grok session stopped; no side effects replayed",
						...(cleanupError ? { result: { status: "cleanup_failed" } } : {}),
					},
				}),
				context,
			);
		},
	});
	async function abortRequest(request: Request): Promise<void> {
		const id = request.id ?? (await request.created.promise);
		await request.harness.abortTask(id, BACKGROUND_CONTEXT);
		await request.closed.promise;
	}
	function serialize<T>(run: () => Promise<T>): Promise<T> {
		const result = operation.then(run, run);
		operation = result.then(
			() => {},
			() => {},
		);
		return result;
	}
	function makeRequest(
		harness: Harness,
		conversationId: ConversationId,
		audio?: RealtimeAudio,
	): Request {
		return {
			harness,
			conversationId,
			id: undefined,
			...(audio ? { audio } : {}),
			created: deferred<TaskId<Result>>(),
			ready: deferred<void>(),
			closed: deferred<void>(),
			ended: deferred<void>(),
		};
	}
	async function begin(
		harness: Harness,
		conversationId: ConversationId,
		context: Context,
		mode: Input["mode"],
		audio?: RealtimeAudio,
	): Promise<void> {
		pendingStarts++;
		const expected = ++generation;
		return serialize(async () => {
			if (active) await abortRequest(active);
			await dictation.cancel();
			if (expected !== generation) throw new Error("Grok startup cancelled");
			const requestId = crypto.randomUUID();
			const request = makeRequest(harness, conversationId, audio);
			requests.set(requestId, request);
			active = request;
			try {
				request.id = await harness.commit(
					(tx) =>
						tx.createTask(
							service,
							{ requestId, mode },
							{
								conversationId,
								ownership: { kind: "conversation" },
								background: true,
							},
						),
					context,
				);
				request.created.resolve(request.id);
				harness.resume();
				await awaitWithContext(request.ready.promise, context);
			} catch (error) {
				if (request.id !== undefined) await abortRequest(request);
				else {
					request.created.reject(error);
					request.closed.resolve();
					requests.delete(requestId);
					if (active === request) active = undefined;
				}
				throw error;
			}
		}).finally(() => {
			pendingStarts--;
		});
	}
	async function stop(): Promise<void> {
		generation++;
		const request = active;
		if (request) await abortRequest(request);
		return serialize(async () => {
			if (active) await abortRequest(active);
			await dictation.cancel();
		});
	}
	async function stopCall(): Promise<void> {
		if (active?.transferred) return active.transferred.stopCall();
		if (active?.arrivalLink && active.stopCall) return active.stopCall();
		return stop();
	}
	async function send(
		text: string,
		requestId = crypto.randomUUID(),
	): Promise<void> {
		if (!text.trim()) throw new Error("Message must be nonempty");
		if (active?.transferred) return active.transferred.sendText(text.trim());
		if (active?.binding?.call)
			return active.binding?.call.send(text.trim(), `grok:typed:${requestId}`);
		const target = listener ?? active;
		if (!target) throw new Error("No Grok conversation is selected");
		const conversation = await target.harness.conversation(
			target.conversationId,
			BACKGROUND_CONTEXT,
		);
		if (!conversation) throw new Error("Conversation no longer exists");
		await conversation.submit(
			{
				type: "input",
				content: text.trim(),
				requestId: `grok:typed:${requestId}`,
				whenBusy: "steer",
			},
			BACKGROUND_CONTEXT,
		);
	}
	async function finishDictation(): Promise<string> {
		const request = active;
		const text = await dictation.finish();
		if (request) {
			request.ended.resolve();
			await request.closed.promise;
			await deliverDraft(request, text);
		}
		return text;
	}
	async function configure(models: Models, patch: unknown) {
		const save = settingsOperation.then(async () => {
			const snapshot = await settingsContribution?.read();
			const base = snapshot
				? snapshot.effective
				: options.settings
					? normalizeConfig(await options.settings.load(), config)
					: config;
			const next = normalizeConfig(patch, base);
			if (isRecord(patch) && Object.hasOwn(patch, "access")) {
				const auth = await models.checkAuth("xai");
				if (!auth || auth.type !== next.access)
					throw new Error(
						"Selected xAI authentication type is unavailable; settings unchanged",
					);
			}
			if (settingsContribution && snapshot && options.preferences) {
				const scope = options.preferences.writeScope;
				const override = grokSettingsDefinition.validateOverride(patch);
				const changed = Object.fromEntries(
					Object.entries(override).filter(
						([key, value]) =>
							value !== Object.getOwnPropertyDescriptor(base, key)?.value,
					),
				);
				const result = await settingsContribution.replaceOverride({
					scope,
					value: { ...snapshot.overrides[scope], ...changed },
					expectedRevision: snapshot.revision,
				});
				if (result.application.status === "failed")
					throw new Error(result.application.message);
				return { ...result.snapshot.effective };
			}
			await options.settings?.save(next);
			config = next;
			publish();
			return { ...config };
		});
		settingsOperation = save.then(
			() => {},
			() => {},
		);
		return save;
	}
	const lanService = defineTask<
		Input,
		Checkpoint,
		Result,
		Record<string, never>
	>({
		name: `${name}.lan`,
		version: 1,
		initial: () => ({ phase: "run", entered: false }),
		phases: {
			run: async (task, runtime, context) => {
				const request = lanRequests.get(task.input.requestId);
				if (task.state.checkpoint.entered || !request) {
					await runtime.commit(
						() => ({
							status: "terminal",
							outcome: {
								status: "failed",
								error: {
									message:
										"Interrupted Grok LAN listener was not reopened; start explicitly",
								},
							},
						}),
						context,
					);
					return;
				}
				await runtime.commit(
					() => ({
						status: "running",
						checkpoint: { phase: "run", entered: true },
					}),
					context,
				);
				let failure: unknown;
				let activityWatch: Awaited<ReturnType<typeof watchEvents>> | undefined;
				try {
					const grant = await capabilities(runtime, context);
					await refreshSettings();
					if (!grant.lan)
						throw new Error("LAN hosting capability was not granted");
					lan = await openLan({
						capability: grant.lan,
						signal: runtime.signal,
						port: config.port,
						callbacks: {
							start: (audio) =>
								active?.transferred
									? active.transferred.startCall()
									: active?.arrivalLink &&
											active.binding?.stopped &&
											active.startCall
										? active.startCall()
										: begin(
												request.harness,
												runtime.conversationId,
												BACKGROUND_CONTEXT,
												"voice",
												audio,
											),
							startDictation: (audio) =>
								begin(
									request.harness,
									runtime.conversationId,
									BACKGROUND_CONTEXT,
									"dictation",
									audio,
								),
							finishDictation,
							cancelDictation: stop,
							cancelStartup: () => {
								if (
									active &&
									(!active.started || view.status === "reconnecting")
								)
									void (
										active.arrivalLink && active.stopCall
											? active.stopCall()
											: abortRequest(active)
									).catch((error) => runtime.report(error));
							},
							stop,
							stopCall,
							send,
							state,
							theme: () => grant.theme?.() ?? DEFAULT_THEME,
							mute: (muted) => {
								if (active?.transferred)
									active.transferred.setInputMuted(muted);
								else active?.binding?.call?.mute(muted);
								view.muted = muted;
								publish();
							},
							settings: () => ({
								config: { ...config },
								voices: VOICES,
								models: MODELS,
								contextModels: [
									"current",
									"off",
									...runtime.models
										.getModels()
										.map((model) => `${model.provider}/${model.id}`),
								],
								speeds: SPEEDS,
							}),
							configure: (patch) => configure(runtime.models, patch),
						},
					});
					const server = lan;
					request.cleanup = () => server.close();
					activityWatch = await watchEvents(
						request.harness,
						runtime.conversationId,
						context,
					);
					activity(Boolean(activityWatch.snapshot.run));
					activityWatch.start(async (events) => {
						for (const event of events) {
							if (event.type === "run_start") activity(true);
							else if (event.type === "run_end") activity(false);
							else if (event.type === "snapshot") activity(Boolean(event.run));
						}
					});
					present("lan", { urls: server.urls });
					request.ready.resolve();
					await awaitWithContext(request.ended.promise, context);
				} catch (error) {
					failure = error;
					request.ready.reject(error);
				} finally {
					try {
						await activityWatch?.stop();
						await request.cleanup?.();
					} catch (error) {
						const cleanupError = new Error(
							"Grok LAN teardown failed; host must confirm listener cleanup",
							{ cause: error },
						);
						failure = cleanupError;
						cleanupFailures.set(task.input.requestId, cleanupError);
						request.closed.reject(cleanupError);
						runtime.report(cleanupError);
					}
					lan = undefined;
					if (listener === request) listener = undefined;
					lanRequests.delete(task.input.requestId);
					request.closed.resolve();
				}
				if (runtime.signal.aborted) throw runtime.signal.reason;
				await runtime.commit(
					() => ({
						status: "terminal",
						outcome:
							failure === undefined
								? { status: "completed", result: { status: "stopped" } }
								: { status: "failed", error: { message: String(failure) } },
					}),
					context,
				);
			},
		},
		abort: async (task, runtime, context) => {
			const cleanupError = cleanupFailures.get(task.input.requestId);
			cleanupFailures.delete(task.input.requestId);
			const request = lanRequests.get(task.input.requestId);
			if (request) {
				request.ready.reject(new Error("Grok LAN startup cancelled"));
				await request.cleanup?.();
				request.closed.resolve();
				lanRequests.delete(task.input.requestId);
				if (listener === request) listener = undefined;
			}
			await runtime.commit(
				() => ({
					status: "terminal",
					outcome: {
						status: "aborted",
						...(cleanupError
							? {
									reason: cleanupError.message,
									result: { status: "cleanup_failed" },
								}
							: {}),
					},
				}),
				context,
			);
		},
	});
	const component = {
		extension: defineExtension({
			name,
			tasks: [service, lanService, toolTask],
		}),
		state,
		settings: () => ({ ...config }),
		settingsContribution,
		configure,
		async loadSettings() {
			await refreshSettings();
			publish();
			return { ...config };
		},
		start: (
			harness: Harness,
			conversationId: ConversationId,
			context: Context,
		) =>
			active?.conversationId === conversationId && active.transferred
				? active.transferred.startCall()
				: active?.conversationId === conversationId &&
						active.arrivalLink &&
						active.binding?.stopped &&
						active.startCall
					? active.startCall()
					: begin(harness, conversationId, context, "voice"),
		startDictation: (
			harness: Harness,
			conversationId: ConversationId,
			context: Context,
		) => begin(harness, conversationId, context, "dictation"),
		finishDictation,
		cancelDictation: stop,
		stop: stopCall,
		send,
		mute(muted: boolean) {
			if (active?.transferred) active.transferred.setInputMuted(muted);
			else active?.binding?.call?.mute(muted);
			view.muted = muted;
			publish();
		},
		handoff: {
			transport: "pcm24" as const,
			async depart(
				channel: VoiceHandoffChannel,
				target: { transport: string },
			): Promise<void> {
				if (target.transport !== "pcm24")
					throw new Error(
						"Voice destination is not compatible with Grok pcm24",
					);
				const request = active;
				const call = request?.binding?.call;
				const audio = request?.ownedAudio;
				if (
					!request ||
					!call ||
					!audio ||
					departing ||
					pendingStarts ||
					!["listening", "responding"].includes(view.status)
				)
					throw new Error("Grok voice is not ready to transfer");
				departing = true;
				let released = false;
				const captured: CapturedHandoff = {
					audio,
					inputMuted: view.muted,
					alternateVoice: request.alternateVoice ?? false,
					sourceActive: () =>
						active === request && request.binding?.call === call && call.active,
					closed: () => {
						// Retain selection after disconnection. Start must not silently call this audio host.
						setStatus("idle");
					},
					async release(callbacks, controls) {
						if (active !== request || request.binding?.call !== call)
							throw new Error("Source voice changed during transfer");
						const snapshot = await watchEvents(
							request.harness,
							request.conversationId,
							BACKGROUND_CONTEXT,
						);
						const busy =
							Boolean(snapshot.snapshot.run) ||
							snapshot.snapshot.inbox.length > 0;
						await snapshot.stop();
						if (busy)
							throw new Error(
								"Source agent started working again before transfer",
							);
						controls.setInputMuted(view.muted);
						try {
							await call.detachAudio(audio, callbacks);
						} catch (error) {
							if (!call.active) request.ended.reject(error);
							throw error;
						}
						request.binding?.detach();
						request.transferred = controls;
						released = true;
						setStatus("transferred");
						controls.onSessionEvent((event, data) => {
							if (active !== request) return;
							if (event === "state" && isRecord(data)) {
								if (typeof data["piBusy"] === "boolean")
									activity(data["piBusy"]);
								if (typeof data["muted"] === "boolean")
									view.muted = data["muted"];
								const remoteActivity = data["activity"];
								if (
									isRecord(remoteActivity) &&
									typeof remoteActivity["text"] === "string"
								)
									view.activity.text = remoteActivity["text"];
							}
							present(event, isRecord(data) ? data : { data });
							if (request.arrivalLink && !request.arrivalLink.closed)
								request.arrivalLink.notify({
									type: "session.event",
									event,
									data,
								});
						});
					},
				};
				const departure = startVoiceDeparture({
					channel,
					captured,
					async waitForSettled(signal) {
						const scoped = withAbortSignal(
							AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
							BACKGROUND_CONTEXT,
						);
						const conversation = await request.harness.conversation(
							request.conversationId,
							scoped,
						);
						if (!conversation)
							throw new Error("Source conversation no longer exists");
						await conversation.waitForIdle(scoped);
						await awaitWithContext(call.waitForTools(), scoped);
					},
					onReleased: () => {},
					onClosed: (error) =>
						present("handoff_error", { message: error.message, released }),
				});
				request.departure = departure;
				try {
					await departure.completion;
				} catch (error) {
					if (!released) delete request.departure;
					throw error;
				} finally {
					departing = false;
				}
			},
			async arrive(
				harness: Harness,
				conversationId: ConversationId,
				channel: VoiceHandoffChannel,
				continuity: string,
				context: Context,
			): Promise<void> {
				if (Buffer.byteLength(continuity) > 64 * 1024)
					throw new Error("Voice arrival context is too large");
				const previous = active;
				const returning = Boolean(
					previous?.transferred && !previous.binding?.call,
				);
				if ((active && !returning) || pendingStarts || departing)
					throw new Error(
						"Grok voice or dictation is already active or preparing",
					);
				const requestId = crypto.randomUUID();
				const request = makeRequest(harness, conversationId);
				request.arrival = { channel, continuity };
				if (returning && previous) request.sourceOwner = previous;
				active = request;
				requests.set(requestId, request);
				try {
					request.id = await harness.commit(
						(tx) =>
							tx.createTask(
								service,
								{ requestId, mode: "voice" },
								{
									conversationId,
									ownership: { kind: "conversation" },
									background: true,
								},
							),
						context,
					);
					request.created.resolve(request.id);
					harness.resume();
					await awaitWithContext(request.ready.promise, context);
				} catch (error) {
					try {
						channel.send({ type: "failure", message: asError(error).message });
					} finally {
						channel.close();
					}
					if (request.id !== undefined) await abortRequest(request);
					else {
						request.created.reject(error);
						request.closed.resolve();
						requests.delete(requestId);
						if (active === request) active = undefined;
					}
					if (previous && [...requests.values()].includes(previous)) {
						active = previous;
						setStatus("transferred");
					}
					throw error;
				}
			},
		},
		async startLan(
			harness: Harness,
			conversationId: ConversationId,
			context: Context,
		): Promise<string[]> {
			if (listener) throw new Error("Grok LAN control is already active");
			const requestId = crypto.randomUUID();
			const request = makeRequest(harness, conversationId);
			listener = request;
			lanRequests.set(requestId, request);
			try {
				request.id = await harness.commit(
					(tx) =>
						tx.createTask(
							lanService,
							{ requestId, mode: "voice" },
							{
								conversationId,
								ownership: { kind: "conversation" },
								background: true,
							},
						),
					context,
				);
				request.created.resolve(request.id);
				harness.resume();
				await awaitWithContext(request.ready.promise, context);
				return lan?.urls ?? [];
			} catch (error) {
				if (request.id !== undefined) await abortRequest(request);
				else {
					request.created.reject(error);
					request.closed.resolve();
					listener = undefined;
					lanRequests.delete(requestId);
				}
				throw error;
			}
		},
		async stopLan() {
			if (listener) await abortRequest(listener);
		},
		lanStatus() {
			return {
				running: Boolean(lan),
				urls: lan?.urls ?? [],
				browserAttached: lan?.browserAttached() ?? false,
			};
		},
		async connectLan(
			request: { url: string; host?: string; signal?: AbortSignal },
			harness: Harness,
			conversationId: ConversationId,
			context: Context,
		) {
			request.signal?.throwIfAborted();
			const urls =
				lan?.urls ??
				(await component.startLan(harness, conversationId, context));
			if (!urls.includes(request.url))
				throw new Error(
					"Choose an explicit URL from the running server's URLs",
				);
			if (
				request.host &&
				request.host !== "local" &&
				["localhost", "127.0.0.1", "[::1]"].includes(
					new URL(request.url).hostname,
				)
			)
				throw new Error("A remote browser needs a non-loopback server URL");
			if (!options.startBrowserVoice)
				throw new Error("Browser voice startup capability was not supplied");
			request.signal?.throwIfAborted();
			const { host, ...browser } = request;
			const result = await options.startBrowserVoice({
				...browser,
				provider: "grok",
				...(host && host !== "local" ? { host } : {}),
			});
			request.signal?.throwIfAborted();
			return result;
		},
		/** Call before switching conversations; Harness.close also cancels both owned services. */
		async close() {
			if (listener) await abortRequest(listener);
			await stop();
			await Promise.all([...requests.values()].map(abortRequest));
		},
	};
	return component;
}
