# Grok voice for Pi Durable

Realtime xAI conversation, manual dictation and HTTPS browser controls, with Durable-owned lifecycle and ordinary Durable tools. Requires Node 22.19+, Durable/Models 1.1.0 and an existing xAI credential. Voice is a transport into the selected conversation, not a replacement chat model.

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

Dictation returns its finalized transcript once and optionally sends it to the host's editable draft. It never submits a generation automatically. Typed requests and `send_task` use ordinary conversation admission with explicit steering and request IDs. Other provider function calls become owned Durable child tasks invoking the conversation's selected ordinary registrations, including argument validation, hooks, cancellation and replay policy. There is no Code/Notebook bridge or voice-only tool registry. `send_task`, `end_the_call` and `work_landed` are reserved names; native xAI search also conflicts with a local `web_search` when enabled.

Conversation summaries require `allowContext: true`. `contextModel: "off"` disables them. The selected Models chat model performs summarization separately from realtime voice; opaque native compaction checkpoints are rejected rather than silently omitted. Transcript and diagnostic entries are display-only. Live assistant/activity observation uses Durable's public, experimental `watchEvents` stream.

## Browser control and transfers

LAN hosting requires explicit TLS certificate and listening grants. The certificate grant names the allowed hostnames/IP addresses; the listener grant owns interface exposure and cancellation. Browser controls retain settings, voice, dictation, mute, typed input, activity, PCM playback/drain and peer takeover. Losing a browser connection does not end the host-owned provider session.

This is trusted-network control, **not an internet-safe authenticated service**. Same-origin and Host checks are retained; they are not user authentication. Keep exposure private and close the component before switching conversations.

`handoff.transport` is `pcm24`. An authenticated, ordered and bounded host channel connects `handoff.depart(channel, target)` to `handoff.arrive(harness, conversationId, channel, continuity, context)`. Check the target transport before departure; WebRTC transfers are not interchangeable with PCM. The destination requires a `capabilities.handoff` grant scoped to its channel, conversation and transport. That grant does not authorize native microphone access.

The destination prepares before the source leaves. Departure waits for real agent/tool settlement, retains capture/playout and its physical microphone lease, then replaces the provider binding. Transfers alternate primary/alternate voices and preserve mute, typed work and activity routing. Failure before release keeps the original call; failure afterwards is reported, not disguised as a rollback. The host must not release/reacquire physical microphone ownership between bindings.

## Persistence and native builds

Voice, dictation and LAN are conversation-owned background tasks. Stopping or closing the Harness cancels owned work. Intent is persisted before side effects. After process restart, interrupted tasks report uncertain outcomes; sockets, device processes and microphone leases are not recreated or replayed. Audio teardown or lease-release failure is visible as `cleanup_failed`, and ownership is retained or reported uncertain for host recovery.

Six platform/architecture helpers and their notices are shipped once, under `dist/audio/bin`; browser assets are under `dist/lan/assets`. Rust source, Cargo.lock and build/license scripts are included. `npm run build:audio-helper` builds the current platform with the pinned lockfile. It requires Rust and the native compiler toolchain; Linux additionally needs `pkg-config`, ALSA development headers and the runtime audio service. Cargo's generated `target` tree is excluded from publishing.

`npm run verify:audio-helper` verifies six binaries/notices against recorded SHA256 digests. `npm run plan:audio-helper` reports portable build freshness without Git or another checkout. The carried upstream input stamp is historical provenance; no adapted-script rebuild is claimed. Use the portable plan's `--stamp` only after all six authorized target builds have been assembled.

Offline validation covers Durable admission/child dispatch, dictation completion, ownership, authenticated PCM transfer and restart non-replay. The copied artifact hashes and original pinned input fingerprint were verified. No live xAI account or physical audio device was used. OS permissions, account entitlement, acoustics and real-device reliability still require authorized acceptance; build success alone does not establish them.
