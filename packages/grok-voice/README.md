# Grok voice for Pi Durable

Realtime xAI conversation, manual dictation and HTTPS browser controls, with Durable-owned lifecycle and ordinary Durable tools. Requires Node 22.19+, Durable/Models 1.4.0 and an existing xAI credential. Voice is a transport into the selected conversation, not a replacement chat model.

```sh
npm install https://github.com/IgorWarzocha/pi-durable-components/releases/download/v0.9.0/howaboua-pi-durable-grok-voice-0.9.0.tgz
```

## Transcribe browser audio

Apps that already capture audio can instead call `transcribeGrokDictation({ models, audio, sampleRate, language?, access?, signal })` on the server. It returns the final text without creating a voice call, Harness task, native microphone or LAN server. The host owns capture permissions, upload limits, concurrent-request admission and the editable destination.

`audio` is a `Uint8Array` of mono signed PCM16 little-endian without a WAV header. Supported rates are `16000` and `24000`. Recordings must be between 100 milliseconds and 600 seconds. The input is copied before authentication. 16 kHz passes directly to STT, while 24 kHz uses the existing converter. Omitted, empty or `auto` language uses automatic detection.

`access` is `oauth` or `api_key` and defaults to `oauth`. It must match the credential selected by Models. There is no credential fallback. `checkGrokDictationReadiness({ models, signal, access? })` returns `{ ready: true }` or `{ ready: false, reason }` without opening capture or a provider socket. It may refresh credentials through Models. Readiness checks credentials and configuration, not network availability or account entitlement.

Transcription starts only when explicitly called. A request has a 60-second deadline, propagates cancellation and closes its owned connection. Provider failures reject even when they arrive before `finish`. There are no retries or automatic conversation submissions. An empty successful transcript returns `""`.

## Compose it

`createGrokVoice(options)` returns an extension and host controls. Install its `extension` in the registry and select it on the target conversation. Use a stable `instanceName` when composing multiple instances; keep the same name after restart.

The consuming app supplies:

- One **shared** `AudioLease` to both Grok and GipPity. Acquisition must atomically reject a busy microphone, identify its owner and honor cancellation. Release is idempotent and follows actual teardown.
- `capabilities(environment)`, authorized for that exact execution namespace. Its `audio(config)` constructs a capture/playout adapter; opening devices belongs to the adapter's cancellable `start`, not this factory.
- Optional prompt/settings storage, presentation callbacks and an editable `draft` destination. Global `prompt` and environment-owned `projectPrompt` instructions append in that order to the built-in prompt; Markdown comments are validated and excluded. Credentials remain in Models. Shortcuts are settings for the host to bind; this package does not install terminal UI or keybindings.
- Optional provider `socket` factory for explicit egress. It receives canonical xAI URLs and credential headers; never expose it to browser clients.

`NativeAudio` implements the bundled credential-free helper protocol. It takes a `NativeAudioProcess` grant whose `spawn` returns an owned, piped child process and whose `execute` supports cancellable device discovery. `audioHelperUrl(platform, arch)` identifies the package asset; it does not authorize execution. The host supplies only platform audio-session environment, never provider credentials.

## Controls

- `start(harness, conversationId, context)` / `stop()` / `mute(boolean)`
- `startDictation(...)` / `finishDictation()` / `cancelDictation()`
- `send(text, requestId?)`, `state()`, `settings()`, `configure(models, patch)` and `loadSettings()`
- `startLan(...)` / `stopLan()` / `close()`

For shared settings, pass `preferences: { storage, writeScope: "project" }` instead of the legacy `settings` callbacks. The host supplies `SettingsStorage` from `@howaboua/pi-durable-settings` with explicit global and project storage roots. Grok does not discover paths or persist credentials, prompts or host capabilities.

With preferences enabled, `settingsContribution` exposes `howaboua.grok-voice` for the host's settings service. Grok validates partial settings strictly and merges its defaults, global overrides and project overrides in that order. Service patches, `configure` and browser saves use the same store. A patch preserves omitted overrides and inherited values. Saves take effect only after persistence succeeds and apply on next use, leaving active calls unchanged. Without preferences, the existing configuration and settings callbacks behave as before.

Dictation returns its finalized transcript once and optionally sends it to the host's editable draft. It never submits a generation automatically. Typed requests and `send_task` use ordinary conversation admission with explicit steering and request IDs. Other provider function calls become owned Durable child tasks invoking the conversation's selected ordinary registrations, including argument validation, hooks, cancellation and replay policy. There is no Code/Notebook bridge or voice-only tool registry. `send_task`, `end_the_call`, `stay_quiet` and `work_landed` are reserved names; native xAI search also conflicts with a local `web_search` when enabled.

Conversation summaries require `allowContext: true`. `contextModel: "off"` disables them. The selected Models chat model performs summarization separately from realtime voice; opaque native compaction checkpoints are rejected rather than silently omitted. Transcript and diagnostic entries are display-only. Live assistant/activity observation uses Durable's public, experimental `watchEvents` stream.

## Browser control and transfers

LAN hosting requires explicit TLS certificate and listening grants. The certificate grant names the allowed hostnames/IP addresses; the listener grant owns interface exposure and cancellation. Browser controls retain settings, voice, dictation, mute, typed input, activity, PCM playback/drain and peer takeover. Losing a browser connection does not end the host-owned provider session.

`lanStatus()` reports listener state, advertised URLs and browser attachment. Supply the optional host-owned `startBrowserVoice` callback to use `connectLan({ url, host?, signal? }, harness, conversationId, context)`. The URL must belong to the running listener. Browser's public startup API can supply this callback without a package dependency.

This is trusted-network control, **not an internet-safe authenticated service**. Same-origin and Host checks are retained; they are not user authentication. Keep exposure private and close the component before switching conversations.

`handoff.transport` is `pcm24`. An authenticated, ordered and bounded host channel connects `handoff.depart(channel, target)` to `handoff.arrive(harness, conversationId, channel, continuity, context)`. Check the target transport before departure; WebRTC transfers are not interchangeable with PCM. The destination requires a `capabilities.handoff` grant scoped to its channel, conversation and transport. That grant does not authorize native microphone access.

The destination prepares before the source leaves. Departure waits for real agent/tool settlement, retains capture/playout and its physical microphone lease, then replaces the provider binding. Transfers alternate primary/alternate voices and preserve mute, typed work and activity routing. Failure before release keeps the original call; failure afterwards is reported, not disguised as a rollback. The host must not release/reacquire physical microphone ownership between bindings.

After transfer, Stop closes the selected call but retains its authenticated session binding. Start snapshots fresh destination settings and context through that binding. Stop also cancels a pending restart before joining its operation queue. Returning to the original conversation reuses the existing audio owner. A disconnected selection reports an error rather than silently starting a call on the originating conversation. `close()` still tears down the complete binding chain.

## Persistence and native builds

Voice, dictation and LAN are conversation-owned background tasks. Stopping or closing the Harness cancels owned work. Intent is persisted before side effects. After process restart, interrupted tasks report uncertain outcomes; sockets, device processes and microphone leases are not recreated or replayed. Audio teardown or lease-release failure is visible as `cleanup_failed`, and ownership is retained or reported uncertain for host recovery.

Six platform/architecture helpers and their notices are shipped once, under `dist/audio/bin`; browser assets are under `dist/lan/assets`. Rust source, Cargo.lock and build/license scripts are included. `npm run build:audio-helper` builds the current platform with the pinned lockfile. It requires Rust and the native compiler toolchain; Linux additionally needs `pkg-config`, ALSA development headers and the runtime audio service. Cargo's generated `target` tree is excluded from publishing.

`npm run verify:audio-helper` verifies six binaries/notices against recorded SHA256 digests. `npm run plan:audio-helper` reports portable build freshness without Git or another checkout. The carried upstream input stamp is historical provenance; no adapted-script rebuild is claimed. Use the portable plan's `--stamp` only after all six authorized target builds have been assembled.

Offline validation covers Durable admission/child dispatch, dictation completion, ownership, authenticated PCM transfer and restart non-replay. The copied artifact hashes and original pinned input fingerprint were verified. No live xAI account or physical audio device was used. OS permissions, account entitlement, acoustics and real-device reliability still require authorized acceptance; build success alone does not establish them.
