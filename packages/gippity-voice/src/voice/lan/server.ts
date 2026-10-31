import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import type { Context } from "@earendil-works/chord";
import type { AgentEvent } from "@earendil-works/pi-durable";
import { WebSocket, WebSocketServer } from "ws";
import type { GippityControlConfig } from "../../config.ts";
import {
	GIPPITY_VOICE_MODELS,
	normalizeVoiceApiProvider,
	OPENAI_REALTIME_VOICES,
} from "../../config.ts";
import type { GippityVoiceControls } from "../../controller.ts";
import type {
	AudioLease,
	GippityAppFiles,
	GippityAudioHost,
	GippityLanPermission,
	GippityPresentation,
} from "../../host.ts";
import type { CodexVoiceAuth } from "../auth.ts";
import { boundedAssistantText, LanVoiceActivity } from "./activity.ts";
import {
	createLanVoiceWebManifest,
	getLanVoiceAppAsset,
} from "./app-assets.ts";
import {
	LanVoiceBrowserClients,
	MAX_CONTROL_BYTES,
} from "./browser-clients.ts";
import { LanHostRealtimePeer } from "./browser-peer.ts";
import { LAN_REMOTE_CLIENT_SCRIPT } from "./client-sdk-script.ts";
import { LanVoiceDictation } from "./dictation.ts";
import { LAN_REMOTE_CLIENT_PATH } from "./discovery.ts";
import {
	LanVoiceDraft,
	LanVoiceDraftConflictError,
	LanVoiceDraftError,
} from "./draft.ts";
import type { GippityRemoteApps } from "./remote-app.ts";
import { remoteJsonValue } from "./remote-json.ts";
import { createLanVoiceWebUi } from "./web-ui.ts";

export interface GippityLanServer {
	readonly urls: string[];
	browserAttached(): boolean;
	hasConversation(): boolean;
	acknowledgeTakeover(token: string): Promise<void>;
	proveTakeover(verify: (value: unknown) => Promise<unknown>): Promise<void>;
	releaseForTakeover(): Promise<void>;
	publish(event: GippityPresentation): void;
	broadcast(event: unknown): void;
	agentEvent(event: AgentEvent): void;
	sessionEvent(event: string, data: unknown): void;
	close(): Promise<void>;
}

/** Trusted-network control surface. Credentials never cross this server. */
export async function startGippityLanServer(options: {
	permission: GippityLanPermission;
	audio: GippityAudioHost;
	appFiles: GippityAppFiles | undefined;
	lease: AudioLease;
	owner: string;
	signal: AbortSignal;
	controls: GippityVoiceControls;
	context: Context;
	resolveAuth(): Promise<CodexVoiceAuth>;
	remoteApps: GippityRemoteApps;
	takeoverToken?: string;
	startConversation?(
		factory: () => LanHostRealtimePeer,
		token?: string,
	): Promise<void>;
}): Promise<GippityLanServer> {
	const { permission, controls, context } = options;
	options.signal.throwIfAborted();
	if (
		!permission.origins.length ||
		!permission.bind ||
		!Number.isInteger(permission.port) ||
		permission.port < 1 ||
		permission.port > 65535
	)
		throw new Error(
			"LAN requires explicit bind, port, TLS and advertised origins",
		);
	const origins = permission.origins.map((origin) => {
		const parsed = new URL(origin);
		if (
			parsed.protocol !== "https:" ||
			parsed.origin !== origin ||
			parsed.username ||
			parsed.password
		)
			throw new Error("LAN origins must be exact HTTPS origins");
		return parsed;
	});
	const hosts = new Set(origins.map((origin) => origin.host.toLowerCase()));
	let closing = false;
	let releasing = false;
	let takeoverProof: string | undefined;
	let browserPeer: LanHostRealtimePeer | undefined;
	let browserVoice = false;
	let browserStarting = false;
	let dictationLease: Awaited<ReturnType<AudioLease["acquire"]>> | undefined;
	let clients!: LanVoiceBrowserClients;
	const activity = new LanVoiceActivity({
		initialWorking: false,
		publish: (message) => clients.broadcastControl(message),
	});
	const draft = new LanVoiceDraft({
		publish: (message) => clients.broadcastControl(message),
		sendMessage: (text) => controls.sendText(text, context),
	});
	const releaseDictation = async () => {
		await dictationLease?.release();
		dictationLease = undefined;
	};
	const dictation = new LanVoiceDictation({
		resolveAuth: options.resolveAuth,
		onError: (client, error) => {
			clients.sendControl(client, { type: "error", message: error.message });
			void dictation
				.close()
				.then(releaseDictation)
				.catch((error) =>
					clients.broadcastControl({ type: "error", message: String(error) }),
				);
		},
	});
	clients = new LanVoiceBrowserClients({
		async ensureConversation(takeoverToken) {
			if (closing) throw new Error("LAN server is closing");
			if (browserVoice && controls.active) return;
			browserStarting = true;
			try {
				const factory = () => {
					browserPeer = new LanHostRealtimePeer(options.audio, {
						onAudio: (pcm) => clients.sendConversationAudio(pcm),
						onSpeakerSuppressed: (suppressed) =>
							clients.setConversationSpeakerSuppressed(suppressed),
					});
					return browserPeer;
				};
				if (options.startConversation)
					await options.startConversation(factory, takeoverToken);
				else {
					if (takeoverToken) throw new Error("LAN takeover was not prepared");
					await controls.startVoice(context, factory, true);
				}
				browserVoice = true;
			} finally {
				browserStarting = false;
			}
		},
		async startDictation(client) {
			if (closing) throw new Error("LAN server is closing");
			dictationLease = await options.lease.acquire(
				{ owner: options.owner, mode: "dictation" },
				options.signal,
			);
			try {
				await dictation.start(client);
			} catch (error) {
				await dictation.close();
				await releaseDictation();
				throw error;
			}
		},
		async finishDictation(client, text, revision, selection) {
			try {
				const transcript = await dictation.finish(client);
				let insertion = selection;
				if (text !== undefined) {
					try {
						draft.update(client, text, revision);
					} catch (error) {
						if (!(error instanceof LanVoiceDraftConflictError)) throw error;
						insertion = undefined;
					}
				}
				if (transcript) draft.insertTranscript(client, transcript, insertion);
			} finally {
				await dictation.close();
				await releaseDictation();
			}
		},
		async cancelDictation(client) {
			await dictation.cancel(client);
			await releaseDictation();
		},
		async onConversationActivity(active) {
			if (releasing) return;
			if (!active && browserVoice) {
				browserVoice = false;
				browserPeer = undefined;
				await controls.stopVoice();
			}
		},
		onConversationMute: (value) => controls.setInputMuted(value),
		conversationMuted: () => controls.inputMuted,
		onConversationInputTooQuiet: (value) =>
			clients.broadcastControl({
				type: "microphone",
				state: value ? "too-quiet" : "ok",
			}),
		onConversationAudio: (pcm) => browserPeer?.sendAudio(pcm),
		onDictationAudio: (client, pcm) => dictation.append(client, pcm),
	});
	const originAllowed = (request: IncomingMessage) => {
		const host = request.headers.host?.toLowerCase();
		return (
			host !== undefined &&
			hosts.has(host) &&
			(request.headers.origin === undefined ||
				request.headers.origin === `https://${host}`)
		);
	};
	const server = createServer(
		{ key: permission.key, cert: permission.cert },
		(request, response) => {
			response.setHeader("cache-control", "no-store");
			response.setHeader("x-content-type-options", "nosniff");
			response.setHeader("referrer-policy", "no-referrer");
			if (
				request.method === "GET" &&
				request.url?.startsWith("/api/takeover-proof?")
			) {
				const address = request.socket.remoteAddress;
				const valid =
					["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address ?? "") &&
					takeoverProof !== undefined &&
					new URL(request.url, "https://localhost").searchParams.get(
						"token",
					) === takeoverProof;
				response.writeHead(valid ? 200 : 404, { "content-type": "text/plain" });
				response.end(valid ? takeoverProof : "Not found");
				return;
			}
			if (!originAllowed(request)) {
				send(response, 403, { error: "Unapproved LAN Host or Origin" });
				return;
			}
			void handle(request, response).catch((error) => {
				if (!response.headersSent)
					send(
						response,
						error instanceof LanError
							? error.status
							: error instanceof LanVoiceDraftError
								? 400
								: 500,
						{
							error: error instanceof Error ? error.message : String(error),
						},
					);
				else response.end();
			});
		},
	);
	server.requestTimeout = 15_000;
	server.headersTimeout = 10_000;
	server.keepAliveTimeout = 5_000;
	const sockets = new WebSocketServer({
		noServer: true,
		maxPayload: MAX_CONTROL_BYTES,
	});
	server.on("upgrade", (request, socket, head) => {
		const url = new URL(request.url ?? "/", "https://gippity.local");
		const client = bounded(url.searchParams.get("client"), 128);
		if (
			closing ||
			!originAllowed(request) ||
			url.pathname !== "/api/audio" ||
			!client
		) {
			socket.destroy();
			return;
		}
		sockets.handleUpgrade(request, socket, head, (ws) =>
			clients.connectAudio(client, ws),
		);
	});
	async function handle(request: IncomingMessage, response: ServerResponse) {
		if (closing) throw new LanError(409, "LAN server is closing");
		const url = new URL(request.url ?? "/", "https://gippity.local");
		const path = url.pathname;
		const config = controls.getConfig();
		if (request.method === "GET") {
			if (path === LAN_REMOTE_CLIENT_PATH)
				return content(
					response,
					"text/javascript; charset=utf-8",
					LAN_REMOTE_CLIENT_SCRIPT,
				);
			if (path === "/api/discovery")
				return send(response, 200, {
					name: "GipPity Durable remote control",
					protocolVersion: 1,
					trustedNetwork: true,
					webApp: {
						mode: config.lan.customWebApp ? "custom" : "bundled",
						path: config.lan.customWebAppPath,
					},
					apps: options.remoteApps.apps(),
					client: { global: "GippityRemote", script: LAN_REMOTE_CLIENT_PATH },
					transport: {
						events: "/api/events",
						audio: "/api/audio",
						rpc: "/api/rpc",
						draft: ["/api/draft", "/api/send", "/api/stop"],
					},
					rpcNotes: [
						"Only explicit application-authorized JSON controls are available. No Pi ExtensionAPI or object traversal.",
					],
				});
			if (path.startsWith("/_gippity/apps/")) {
				const [id, ...tail] = path.slice("/_gippity/apps/".length).split("/");
				const root = id ? options.remoteApps.root(id) : undefined;
				if (!root || !options.appFiles)
					throw new LanError(404, "Remote app not found");
				if (!tail.length) {
					response.writeHead(308, { location: `${path}/` });
					response.end();
					return;
				}
				const asset = await options.appFiles.read(
					root,
					tail.join("/") ? `/${tail.join("/")}` : "/index.html",
				);
				if (!asset) throw new LanError(404, "Remote app asset not found");
				return content(response, asset.contentType, asset.body);
			}
			if (path === "/api/settings")
				return send(response, 200, await controls.settings(context));
			if (path === "/api/events") {
				const client = bounded(url.searchParams.get("client"), 128);
				if (!client) throw new LanError(400, "Browser client ID is required");
				response.writeHead(200, {
					connection: "keep-alive",
					"content-type": "text/event-stream; charset=utf-8",
					"x-accel-buffering": "no",
				});
				response.write("event: ready\ndata: {}\n\n");
				clients.connectEvents(client, response);
				if (options.takeoverToken)
					clients.sendControl(client, {
						type: "ready",
						takeoverToken: options.takeoverToken,
					});
				clients.sendControl(client, draft.snapshot());
				clients.sendControl(client, activity.snapshot());
				clients.sendControl(client, {
					type: "mute",
					muted: controls.inputMuted,
				});
				const app = options.remoteApps.snapshot();
				if (app) clients.sendControl(client, app);
				return;
			}
			if (!path.startsWith("/api/") && !path.startsWith("/_gippity/")) {
				if (config.lan.customWebApp) {
					if (!config.lan.customWebAppPath || !options.appFiles)
						throw new LanError(
							409,
							"Custom app files permission and configured root are required",
						);
					const decoded = decodeURIComponent(path);
					if (
						decoded.includes("\\") ||
						decoded.includes("\0") ||
						decoded.split("/").some((part) => part === "." || part === "..")
					)
						throw new LanError(400, "Invalid app asset path");
					const asset = await options.appFiles.read(
						config.lan.customWebAppPath,
						decoded === "/" ? "/index.html" : path,
					);
					if (!asset) throw new LanError(404, "App asset not found");
					return content(response, asset.contentType, asset.body);
				}
				if (path === "/") {
					response.setHeader(
						"content-security-policy",
						"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; worker-src 'self' blob:; media-src 'self' blob:; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
					);
					return content(
						response,
						"text/html; charset=utf-8",
						createLanVoiceWebUi(),
					);
				}
				if (path === "/manifest.webmanifest")
					return content(
						response,
						"application/manifest+json",
						createLanVoiceWebManifest(),
					);
				const asset = getLanVoiceAppAsset(path);
				if (asset) return content(response, asset.contentType, asset.body);
			}
			throw new LanError(404, "Not found");
		}
		if (request.method !== "POST") throw new LanError(404, "Not found");
		if (
			request.headers["content-type"]?.split(";")[0]?.trim() !==
			"application/json"
		)
			throw new LanError(415, "JSON content type required");
		const body = await readBody(request);
		if (closing) throw new LanError(409, "LAN server is closing");
		if (path === "/api/settings") {
			const choices = await controls.settings(context);
			const current = controls.getConfig();
			const voice: Partial<GippityControlConfig["voice"]> = {};
			for (const [key, value] of Object.entries(body)) {
				if (key === "clientId") continue;
				if (key === "apiProvider") {
					const provider = normalizeVoiceApiProvider(value);
					if (!provider)
						throw new LanError(400, "Enter a valid API provider name");
					voice.apiProvider = provider;
				} else if (key === "model") {
					const model = GIPPITY_VOICE_MODELS.find((model) => model === value);
					if (!model) throw new LanError(400, "Choose a listed voice model");
					voice.model = model;
				} else if (
					key === "realtimeVoice" ||
					key === "realtimeAlternateVoice"
				) {
					const selected = OPENAI_REALTIME_VOICES.find(
						(voice) => voice === value,
					);
					if (!selected)
						throw new LanError(400, "Choose a listed Realtime voice");
					voice[key] = selected;
				} else if (key === "v3Voice" || key === "v3AlternateVoice") {
					if (
						typeof value !== "string" ||
						!(choices.voices as readonly string[]).includes(value)
					)
						throw new LanError(400, "Choose a listed voice");
					voice[key] = value as GippityControlConfig["voice"]["v3Voice"];
				} else if (
					key === "contextReasoning" ||
					key === "taskDelegationReasoning"
				) {
					if (
						typeof value !== "string" ||
						!(choices.contextReasoningLevels as readonly string[]).includes(
							value,
						)
					)
						throw new LanError(400, "Choose a listed reasoning level");
					voice[key] =
						value as GippityControlConfig["voice"]["contextReasoning"];
				} else if (key === "contextModel") {
					if (value === null) voice.contextModel = undefined;
					else {
						if (!value || typeof value !== "object" || Array.isArray(value))
							throw new LanError(400, "Choose a listed context model");
						const model = value as Record<string, unknown>;
						const selected = [
							...choices.contextModels,
							...(current.voice.contextModel
								? [current.voice.contextModel]
								: []),
						].find(
							(option) =>
								option.provider === model["provider"] &&
								option.modelId === model["modelId"],
						);
						if (
							!selected ||
							Object.keys(model).some(
								(field) => field !== "provider" && field !== "modelId",
							)
						)
							throw new LanError(400, "Choose an available context model");
						voice.contextModel = selected;
					}
				} else if (
					key === "autoResumeRealtime" ||
					key === "webSearch" ||
					key === "refreshRealtimeAfterCompaction" ||
					key === "delegationAcknowledgements" ||
					key === "forwardReasoningSummaries"
				) {
					if (typeof value !== "boolean")
						throw new LanError(400, "Voice switches must be boolean");
					voice[key] = value;
				} else throw new LanError(400, "Unknown voice setting");
			}
			await controls.configureVoice(voice);
			return send(response, 200, await controls.settings(context));
		}
		const client = bounded(body["clientId"], 128);
		if (!client) throw new LanError(400, "Browser client ID required");
		if (path === "/api/draft")
			return send(response, 200, {
				ok: true,
				revision: draft.update(client, body["text"], body["revision"]),
			});
		if (path === "/api/send") {
			await draft.send(client, body["text"], body["revision"]);
			return send(response, 200, { ok: true });
		}
		if (path === "/api/stop") {
			clients.release(
				client,
				undefined,
				body["terminateConversation"] === true,
			);
			return send(response, 200, { ok: true });
		}
		if (path === "/api/rpc") {
			const id =
				typeof body["id"] === "string" || typeof body["id"] === "number"
					? body["id"]
					: null;
			try {
				const result = await controls.rpc(body);
				return send(response, 200, {
					id,
					ok: true,
					result: remoteJsonValue(result),
				});
			} catch (error) {
				return send(response, 200, {
					id,
					ok: false,
					error: {
						name: error instanceof Error ? error.name : "Error",
						message: String(error instanceof Error ? error.message : error),
					},
				});
			}
		}
		throw new LanError(404, "Not found");
	}
	const heartbeat = setInterval(() => clients.heartbeat(), 15_000);
	heartbeat.unref();
	const removeAppEvents = options.remoteApps.onMessage((message) =>
		clients.broadcastControl(message),
	);
	let closed: Promise<void> | undefined;
	const close = () =>
		(closed ??= (async () => {
			closing = true;
			clearInterval(heartbeat);
			removeAppEvents();
			options.signal.removeEventListener("abort", aborted);
			const listening = server.listening
				? new Promise<void>((resolve, reject) =>
						server.close((error) => (error ? reject(error) : resolve())),
					)
				: Promise.resolve();
			for (const socket of sockets.clients) socket.terminate();
			if (!releasing && (browserVoice || browserStarting))
				await controls.stopVoice();
			browserVoice = false;
			await clients.close();
			await dictation.close();
			await releaseDictation();
			server.closeAllConnections();
			await listening;
			sockets.close();
		})());
	const aborted = () => {
		void close().catch(() => {});
	};
	options.signal.addEventListener("abort", aborted, { once: true });
	try {
		await new Promise<void>((resolve, reject) => {
			const failed = (error: Error) => {
				server.off("listening", listening);
				reject(error);
			};
			const listening = () => {
				server.off("error", failed);
				resolve();
			};
			server.once("error", failed);
			server.once("listening", listening);
			server.listen(permission.port, permission.bind);
		});
		options.signal.throwIfAborted();
	} catch (error) {
		await close();
		throw error;
	}
	server.on("error", (error) =>
		clients.broadcastControl({ type: "error", message: error.message }),
	);
	return {
		urls: origins.map((origin) => `${origin.origin}/`),
		browserAttached: () =>
			[...sockets.clients].some((peer) => peer.readyState === WebSocket.OPEN),
		hasConversation: () => browserVoice && controls.active,
		acknowledgeTakeover: (token) => clients.takeover(token),
		async proveTakeover(verify) {
			if (takeoverProof)
				throw new Error("A LAN listener proof is already pending");
			const token = randomUUID();
			takeoverProof = token;
			try {
				await verify({ port: permission.port, token });
			} finally {
				takeoverProof = undefined;
			}
		},
		async releaseForTakeover() {
			releasing = true;
			await close();
		},
		broadcast: (value) => clients.broadcastControl(value),
		close,
		sessionEvent(event, data) {
			clients.broadcastControl({
				type: "durable.event",
				event,
				data: remoteJsonValue(data),
			});
			if (event === "run_start") activity.working();
			if (event === "run_end") activity.settled();
		},
		publish(event) {
			if (event.type === "activity") {
				if (event.state === "working") activity.working();
				else if (event.state === "waiting") activity.waiting(event.text);
				else activity.settled();
			}
			if (event.type === "status") clients.broadcastControl(event);
			else if (event.type === "error") clients.broadcastControl(event);
			else if (event.type === "lifecycle" && !event.active)
				clients.broadcastControl({ type: "stop", reason: "voice-ended" });
		},
		agentEvent(event) {
			if (event.type === "snapshot") {
				if (event.run) activity.working();
				else activity.settled();
				return;
			}
			clients.broadcastControl({
				type: "durable.event",
				event: event.type,
				data: remoteJsonValue(event),
			});
			if (event.type === "run_start") activity.working();
			if (event.type === "run_end") activity.settled();
			if (event.type === "message_end") {
				const text = boundedAssistantText(
					(event.entry.model ?? []).flatMap((message) =>
						message.role === "assistant" && message.stopReason !== "toolUse"
							? message.content
							: [],
					),
				);
				if (text) activity.settled(text);
			}
		},
	};
}

class LanError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}
function bounded(value: unknown, max: number) {
	return typeof value === "string" &&
		value.length > 0 &&
		Buffer.byteLength(value) <= max
		? value
		: undefined;
}
function send(response: ServerResponse, status: number, body: unknown) {
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
	});
	response.end(JSON.stringify(body));
}
function content(
	response: ServerResponse,
	type: string,
	body: string | Uint8Array,
) {
	response.writeHead(200, { "content-type": type });
	response.end(body);
}
async function readBody(
	request: IncomingMessage,
): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const value of request) {
		const chunk = Buffer.from(value);
		size += chunk.byteLength;
		if (size > 300 * 1024) throw new LanError(413, "Request too large");
		chunks.push(chunk);
	}
	let body: unknown;
	try {
		body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new LanError(400, "Invalid JSON");
	}
	if (!body || typeof body !== "object" || Array.isArray(body))
		throw new LanError(400, "JSON object required");
	return body as Record<string, unknown>;
}
