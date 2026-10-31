import type { Context } from "@earendil-works/chord";
import type { ContextView, ConversationId } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { ClientOptions, WebSocket } from "ws";
import type { SettingsStorage } from "../../../internal/settings/index.ts";
import type { RealtimeAudio } from "./audio.ts";
import type { GrokRealtimeConfig } from "./config.ts";
import type { VoiceHandoffChannel } from "./handoff-contract.ts";
import type { LanOptions } from "./lan/server.ts";
import type { LanVoiceWebTheme } from "./lan/theme.ts";

/** Host-controlled provider egress. Canonical xAI URLs and credentials never enter LAN clients. */
export type GrokSocketFactory = (
	url: string,
	protocols: string[],
	options: ClientOptions,
) => WebSocket;

export interface AudioLease {
	acquire(
		owner: { owner: string; mode: "voice" | "dictation" },
		signal: AbortSignal,
	): Promise<{ release(): Promise<void> }>;
}
export interface GrokHostCapabilities {
	/** Must belong to this exact execution namespace. */
	environmentId: string;
	audio(config: GrokRealtimeConfig): RealtimeAudio;
	lan?: LanOptions["capability"];
	theme?(): LanVoiceWebTheme;
	/** Authorizes only this target/channel; not physical microphone or process access. */
	handoff?(
		input: {
			channel: VoiceHandoffChannel;
			conversationId: ConversationId;
			transport: "pcm24";
		},
		signal: AbortSignal,
	): Promise<{ release(): Promise<void> }>;
}
interface GrokVoiceBaseOptions {
	/** Host-owned browser automation, e.g. Browser's public startBrowserVoice API. */
	startBrowserVoice?(request: {
		url: string;
		provider: "grok";
		host?: string;
		signal?: AbortSignal;
	}): Promise<{
		state: "listening" | "error" | "timeout";
		url: string;
		refId?: string;
		detail?: string;
		status?: string;
	}>;
	/** Stable suffix when composing several instances in one registry. Persist this across restart. */
	instanceName?: string;
	/** Supply the SAME atomic, rejecting lease to both voice components. */
	lease: AudioLease;
	capabilities(
		environment: ExecutionEnv | undefined,
	): GrokHostCapabilities | undefined;
	config?: Partial<GrokRealtimeConfig>;
	/** Explicit permission to export conversation context to the selected Models summarizer and xAI. */
	allowContext?: boolean;
	/** Project authorised retained checkpoints or saved notes into the voice history. */
	projectContext?(
		request: { conversationId: ConversationId; view: ContextView },
		context: Context,
	): Promise<ContextView>;
	/** Additional global instructions; append to the built-in prompt, never replace it. */
	prompt?(
		environment: ExecutionEnv | undefined,
		signal: AbortSignal,
	): Promise<string>;
	/** Additional project instructions, appended last through the environment-owned store. */
	projectPrompt?(
		environment: ExecutionEnv | undefined,
		signal: AbortSignal,
	): Promise<string>;
	present?(event: { type: string; [key: string]: unknown }): void;
	draft?(text: string): void | Promise<void>;
	/** Nonfatal host presentation and teardown failures. */
	report?(error: unknown): void;
	socket?: GrokSocketFactory;
}

export type GrokVoiceOptions = GrokVoiceBaseOptions &
	(
		| {
				preferences: {
					storage: SettingsStorage;
					writeScope: "global" | "project";
				};
				settings?: never;
		  }
		| {
				preferences?: never;
				settings?: {
					load(): Promise<unknown>;
					save(config: GrokRealtimeConfig): Promise<void>;
				};
		  }
	);
