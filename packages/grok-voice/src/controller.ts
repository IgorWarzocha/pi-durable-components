import type { Context, JsonValue } from "@earendil-works/chord";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	type AgentEvent,
	type AgentEventStream,
	type Harness,
	type TaskId,
	type ToolExecutionResult,
	watchEvents,
} from "@earendil-works/pi-durable";
import type { createNestedToolTask } from "../../execution/src/nested.ts";
import { readToolContract } from "../../execution/src/tool-contract.ts";
import type { AudioCallbacks, RealtimeAudio } from "./audio.ts";
import type { GrokRealtimeConfig } from "./config.ts";
import type { VoiceRuntime } from "./context.ts";
import { resolveConnection } from "./credentials.ts";
import type { GrokSocketFactory } from "./host.ts";
import { completedVoiceReasoningSummary } from "./reasoning-summary.ts";
import { GrokSession } from "./session.ts";
import type { SwitchableAudio } from "./switchable-audio.ts";
import type { GrokToolWireDefinition } from "./tools.ts";

export interface PreparedVoice {
	connection: Awaited<ReturnType<typeof resolveConnection>>;
	summary: string;
}

export interface VoiceCallOptions {
	runtime: VoiceRuntime;
	context: Context;
	harness: Harness;
	audio: RealtimeAudio;
	config: GrokRealtimeConfig;
	instructions: string;
	prepareContext(): Promise<string>;
	append(kind: string, data: JsonValue): void;
	status(status: string): void;
	activity(working: boolean, text?: string): void;
	failed(error: Error): void;
	ended(): void;
	socket?: GrokSocketFactory;
	toolTask: ReturnType<typeof createNestedToolTask>;
}

/** Live state belongs to one Durable service invocation; never reconstructed after restart. */
export class VoiceCall {
	private readonly options: VoiceCallOptions;
	private session: GrokSession;
	private tools: GrokToolWireDefinition[] = [];
	private watch: AgentEventStream | undefined;
	private muted = false;
	private busy = false;
	private ending = 0;
	private playback = 0;
	private reconnecting = false;
	private closed = false;
	private forwarded = 0;
	private partial: AssistantMessage | undefined;
	private readonly abortAudio: () => void;
	private pendingTools = 0;
	private readonly toolWaiters = new Set<() => void>();

	constructor(options: VoiceCallOptions) {
		this.options = options;
		this.session = this.createSession();
		this.abortAudio = () => {
			this.session.close();
			void options.audio
				.close()
				.catch((error) => options.runtime.report(error));
		};
		options.runtime.signal.addEventListener("abort", this.abortAudio, {
			once: true,
		});
	}

	async start(): Promise<void> {
		await this.activate(await this.prepare());
	}
	async prepare(): Promise<PreparedVoice> {
		const { runtime, context, config } = this.options;
		const agent = await runtime.agent(context);
		for (const tool of agent.tools) {
			if (readToolContract(tool).nativeOnly) continue;
			if (["send_task", "end_the_call", "work_landed"].includes(tool.name))
				throw new Error(`Reserved voice tool: ${tool.name}`);
			if (config.webSearch && tool.name === "web_search")
				throw new Error(
					"A local tool uses web_search; rename it or disable native Web search",
				);
			this.tools.push({
				type: "function",
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			});
		}
		this.options.status("summarizing");
		const summary = await this.options.prepareContext();
		if (summary)
			this.options.append("grok-realtime-context", { text: summary });
		this.options.status("connecting");
		const connection = await resolveConnection(
			runtime.models,
			config,
			runtime.signal,
		);
		runtime.signal.throwIfAborted();
		return { connection, summary };
	}
	async activate(
		prepared: PreparedVoice,
		arrival?: { inputMuted: boolean; alternateVoice: boolean },
	): Promise<void> {
		const { runtime, context } = this.options;
		if (arrival) {
			this.muted = arrival.inputMuted;
			if (arrival.alternateVoice)
				this.options.config = {
					...this.options.config,
					voice: this.options.config.alternateVoice,
				};
			this.options.audio.setMuted(this.muted);
			this.session.setMuted(this.muted);
		}
		this.watch = await watchEvents(
			this.options.harness,
			runtime.conversationId,
			context,
		);
		this.setBusy(Boolean(this.watch.snapshot.run));
		this.partial = this.watch.snapshot.generation?.message;
		this.watch.start(async (events) => {
			for (const event of events) await this.event(event);
		});
		await this.options.audio.start({
			onAudio: (pcm) => {
				if (this.closed || this.muted) return;
				try {
					this.session.appendAudio(pcm);
				} catch (error) {
					this.options.failed(asError(error));
				}
			},
			onError: (error) => this.options.failed(error),
		});
		runtime.signal.throwIfAborted();
		await this.session.start(
			prepared.connection,
			this.options.config,
			prepared.summary,
			runtime.signal,
			this.tools,
			this.options.instructions,
			Boolean(arrival),
		);
		if (arrival)
			this.session.context(
				"The caller has just been put through to this conversation. Greet them briefly with a distinct welcome; do not recap prior work or start an agent task.",
			);
		this.options.append("grok-realtime-lifecycle", { state: "started" });
	}

	private createSession(): GrokSession {
		const { runtime, context, audio } = this.options;
		return new GrokSession(
			{
				audio: (pcm) => {
					if (!this.closed) audio.play(pcm);
				},
				audioDone: async (responseId) => {
					const generation = this.playback;
					await audio.drain();
					this.options.append("grok-realtime-diagnostic", {
						type:
							generation === this.playback && !this.closed
								? "playback.drained"
								: "playback.drain_interrupted",
						response_id: responseId ?? null,
					});
				},
				interrupt: () => {
					this.ending++;
					this.playback++;
					audio.clear();
				},
				endCall: () => {
					void this.finish().catch((error) =>
						this.options.failed(asError(error)),
					);
				},
				transcript: (role, text) =>
					this.options.append("grok-realtime-transcript", { role, text }),
				task: async (callId, request) => {
					await this.submit(
						request,
						`grok:${runtime.taskId}:delegate:${callId}`,
					);
					this.options.append("grok-realtime-delegation", {
						id: callId,
						request,
					});
				},
				executeTool: async (name, args) => {
					this.pendingTools++;
					try {
						let id!: TaskId<ToolExecutionResult>;
						await runtime.commit(async (tx) => {
							id = await tx.createTask(
								this.options.toolTask,
								{ name, arguments: args as JsonValue },
								{ ownership: { kind: "task", taskId: runtime.taskId } },
							);
						}, context);
						const receipt = await runtime.waitForTask(id, context);
						if (receipt.state.outcome.status !== "completed")
							throw new Error(`Tool ${name}: ${receipt.state.outcome.status}`);
						return receipt.state.outcome.result;
					} finally {
						this.pendingTools--;
						if (!this.pendingTools) {
							for (const done of this.toolWaiters) done();
							this.toolWaiters.clear();
						}
					}
				},
				nativeTool: (id, name, args) =>
					this.options.append("grok-realtime-native-tool", {
						id,
						name,
						args: args as JsonValue,
					}),
				status: (status) => {
					if (!this.closed) this.options.status(status);
				},
				error: (error) => this.options.failed(error),
				disconnected: (error) => {
					void this.resume(error);
				},
				diagnostic: (event) =>
					this.options.append("grok-realtime-diagnostic", event as JsonValue),
			},
			this.options.socket,
		);
	}

	async submit(text: string, requestId: string): Promise<void> {
		if (this.closed)
			throw new Error("Voice call ended before the task was accepted");
		const { runtime, context } = this.options;
		const conversation = await runtime.conversation(
			runtime.conversationId,
			context,
		);
		if (!conversation) throw new Error("Voice conversation no longer exists");
		await conversation.submit(
			{ type: "input", content: text, requestId, whenBusy: "steer" },
			context,
		);
		this.setBusy(true);
	}

	async send(text: string, requestId: string): Promise<void> {
		await this.submit(text, requestId);
		this.session.context(
			`Already delivered to the agent, do not call send_task for this:\n${text}`,
			false,
		);
	}
	mute(muted: boolean): void {
		this.options.audio.setMuted(muted);
		this.session.setMuted(muted);
		this.muted = muted;
		this.options.append("grok-realtime-diagnostic", {
			type: "microphone.muted",
			muted,
		});
	}
	private setBusy(busy: boolean): void {
		this.busy = busy;
		this.session.setPiBusy(busy);
		this.options.activity(busy);
	}

	private async event(event: AgentEvent): Promise<void> {
		if (this.closed) return;
		switch (event.type) {
			case "snapshot":
				this.setBusy(Boolean(event.run));
				this.partial = event.generation?.message;
				break;
			case "run_start":
				this.setBusy(true);
				break;
			case "run_end":
				this.setBusy(false);
				break;
			case "message_start":
				this.forwarded = 0;
				this.partial =
					event.message.role === "assistant"
						? structuredClone(event.message)
						: undefined;
				break;
			case "message_update":
				for (const change of event.changes) {
					if (change.type === "message")
						this.partial = structuredClone(change.message);
					else if (this.partial) {
						if ("block" in change)
							this.partial.content[change.contentIndex] = structuredClone(
								change.block,
							);
						else if (change.type === "text_delta") {
							const block = this.partial.content[change.contentIndex];
							if (block?.type === "text") block.text += change.delta;
						}
					}
				}
				if (this.partial) this.stream(this.partial);
				break;
			case "message_end":
				for (const message of event.entry.model ?? [])
					if (message.role === "assistant") this.message(message);
				this.partial = undefined;
				break;
			case "compaction_end": {
				const receipt = await this.options.runtime.waitForTask(
					event.taskId,
					this.options.context,
				);
				if (receipt.state.outcome.status !== "completed") break;
				try {
					const summary = await this.options.prepareContext();
					if (!this.closed && summary) {
						this.options.append("grok-realtime-context", { text: summary });
						this.session.context(
							`Updated continuity summary after compaction, background only:\n${summary}`,
							false,
						);
					}
				} catch (error) {
					this.options.runtime.report(
						new Error(
							`Voice context refresh failed; current call retained: ${asError(error).message}`,
						),
					);
				}
				break;
			}
			case "tool_execution_start":
				this.options.activity(true, `Using ${event.toolName}`);
				break;
		}
	}
	private stream(message: AssistantMessage): void {
		const text = message.content
			.flatMap((part) => (part.type === "text" ? [part.text] : []))
			.join("\n");
		for (;;) {
			const remaining = text.slice(this.forwarded);
			const match = this.forwarded
				? /\n\s*\n/.exec(remaining)
				: [...remaining.matchAll(/[.!?](?:["')\]]+)?(?=\s|$)/g)].filter(
						(end) => !/\d/.test(remaining[end.index - 1] ?? ""),
					)[1];
			if (!match || match.index === undefined) return;
			const boundary = match.index + match[0].length;
			if (!/[\p{L}\p{N}]/u.test(remaining.slice(boundary))) return;
			const update = remaining.slice(0, boundary).trim();
			this.forwarded += boundary;
			if (update)
				this.session.context(
					`Agent assistant reply continuing; more may follow:\n${update}`,
				);
		}
	}
	private message(message: AssistantMessage): void {
		const text = message.content
			.flatMap((part) => (part.type === "text" ? [part.text] : []))
			.join("\n");
		const tail = text.slice(this.forwarded).trim();
		this.forwarded = 0;
		if (!text.trim() && message.stopReason === "toolUse") {
			const summary = completedVoiceReasoningSummary(message);
			if (summary)
				this.session.context(
					`Agent progress summary, not a completed result:\n${summary}`,
				);
		}
		if (tail)
			this.session.context(
				`Agent assistant ${message.stopReason === "toolUse" ? "progress" : "reply"} ending:\n${tail}`,
			);
		this.options.activity(this.busy, text);
	}
	private async resume(error: Error): Promise<void> {
		if (this.closed || this.options.runtime.signal.aborted || this.reconnecting)
			return;
		if (!this.options.config.autoResume) {
			this.options.failed(error);
			return;
		}
		this.reconnecting = true;
		try {
			this.ending++;
			this.playback++;
			await this.session.shutdown();
			this.options.audio.clear();
			this.session = this.createSession();
			this.session.setMuted(this.muted);
			this.session.setPiBusy(this.busy);
			this.options.status("reconnecting");
			const summary = await this.options.prepareContext();
			const connection = await resolveConnection(
				this.options.runtime.models,
				this.options.config,
				this.options.runtime.signal,
			);
			if (this.closed) return;
			await this.session.start(
				connection,
				this.options.config,
				summary,
				this.options.runtime.signal,
				this.tools,
				this.options.instructions,
				true,
			);
		} catch (failure) {
			if (!this.closed && !this.options.runtime.signal.aborted)
				this.options.failed(
					new Error(`Grok voice could not resume: ${asError(failure).message}`),
				);
		} finally {
			this.reconnecting = false;
		}
	}
	private async finish(): Promise<void> {
		const generation = ++this.ending;
		this.options.status("ending");
		try {
			await this.options.audio.drain();
		} catch (error) {
			this.options.runtime.report(error);
		}
		if (!this.closed && generation === this.ending) this.options.ended();
	}
	async close(): Promise<void> {
		this.closed = true;
		this.options.runtime.signal.removeEventListener("abort", this.abortAudio);
		this.ending++;
		this.playback++;
		this.session.close();
		let watchError: unknown;
		try {
			await this.watch?.stop();
		} catch (error) {
			watchError = error;
		}
		try {
			await this.options.audio.close();
		} finally {
			await this.session.shutdown();
		}
		this.options.append("grok-realtime-lifecycle", { state: "ended" });
		if (watchError !== undefined) throw watchError;
	}
	get active(): boolean {
		return !this.closed;
	}
	async waitForTools(): Promise<void> {
		if (this.pendingTools)
			await new Promise<void>((resolve) => this.toolWaiters.add(resolve));
	}
	/** Closes this provider binding, not the departure-owned physical capture/playout. */
	async detachAudio(
		audio: SwitchableAudio,
		callbacks: AudioCallbacks,
	): Promise<void> {
		if (this.closed || this.reconnecting || this.pendingTools)
			throw new Error("Voice is not ready to transfer");
		this.closed = true;
		this.options.runtime.signal.removeEventListener("abort", this.abortAudio);
		this.ending++;
		this.playback++;
		this.session.close();
		await this.watch?.stop();
		await this.session.shutdown();
		audio.clear();
		audio.transfer(callbacks);
		this.options.append("grok-realtime-lifecycle", {
			state: "ended",
			transferred: true,
		});
	}
}

function asError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}
