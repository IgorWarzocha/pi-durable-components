# GipPity voice for Pi Durable

Talk with a Codex subscription voice assistant while your Durable conversation remains the agent doing the work. Voice requests enter normal Durable admission when the realtime assistant explicitly delegates them. Ordinary voice dialogue stays display-only. Typed messages still work normally.

The component includes local WebRTC audio, manual dictation, microphone mute, device discovery, opt-in call recovery, context refresh after successful compaction, and HTTPS browser control. Browser dictation edits a revision-checked shared draft. Closing a browser leaves an established call running. Stop ends it. Authorized handoff keeps audio on its original host while work moves to another Durable conversation.

## Requirements

- Node 22.19 or newer and Pi Durable, Models and Chord 1.4.0.
- A canonical `openai-codex` OAuth login supplied by the host's Models instance. API keys, custom Codex endpoints and ordinary OpenAI realtime are not supported.
- Explicit native process permission matching the conversation's execution environment. Six native helpers are shipped for Linux, macOS and Windows, on x64 and arm64. Linux needs its audio runtime dependencies.
- One application-owned exclusive audio lease, shared with every voice component, including Grok voice. Acquisition must reject conflicting ownership atomically. Aborting a waiter must not release an existing owner's hardware. Release is idempotent and occurs only after confirmed audio teardown.

Credentials stay in Models. The native helper and browser never receive provider credentials. Native devices, microphone permissions, provider entitlement and acoustic behavior need separate real-device acceptance.

```sh
npm install https://github.com/IgorWarzocha/pi-durable-components/releases/download/v0.8.1/howaboua-pi-durable-gippity-voice-0.8.1.tgz
```

## Transcribe browser audio

For an app that already captures audio, use `transcribeGippityDictation({ models, audio, sampleRate, language?, signal })` on the server. It returns the final text and opens only a transcription connection. It requires no Harness, audio lease, native helper, microphone or LAN server. Nothing is submitted to a conversation.

`audio` is a `Uint8Array` containing mono signed PCM16 little-endian without a WAV header. `sampleRate` must be `16000` or `24000`. Recordings must be between 100 milliseconds and 600 seconds. The component copies the input and converts 16 kHz audio to the provider's 24 kHz format. Omitted, empty or `auto` language uses automatic detection.

Call `checkGippityDictationReadiness({ models, signal })` to check credentials before offering this engine. It returns `{ ready: true }` or `{ ready: false, reason }`. This uses the canonical Codex OAuth resolver and may refresh credentials through Models. It opens no transcription socket and does not prove network availability or account entitlement. Credentials never leave the server.

Transcription runs only when explicitly called. There are no automatic retries. Cancellation and provider errors reject the promise, including failures before audio finishes uploading. The whole request has a 60-second deadline and retains the provider's 10-second final-transcript timeout. Teardown allows up to two seconds for a close handshake before forcing the owned connection closed. An empty successful transcript returns `""`. The host owns capture permissions, upload limits, concurrent-request admission and the editable destination.

## Connect the component

Install `@howaboua/pi-durable-gippity-voice` alongside its pinned peers. In an existing Durable app:

```ts
import { createGippityVoice, createNativeGippityAudioHost } from
  "@howaboua/pi-durable-gippity-voice";

const voice = createGippityVoice({
  namespace: environment.id,
  audio: createNativeGippityAudioHost({
    namespace: environment.id,
    executable: approvedHelperPath,
    cwd: approvedWorkingDirectory,
    env: approvedAudioEnvironment,
  }),
  lease: applicationAudioLease,
  instructions: approvedVoiceInstructions,
  present: event => applicationUi.showVoiceEvent(event),
});

registry.install(voice.extension);
voice.controls.bindHarness(harness, conversation.id);
await voice.controls.startVoice(context);
voice.controls.setInputMuted(true);
await voice.controls.stopVoice();
```

The host chooses an absolute helper path. Shipped helpers are at `voice/bin/<platform>-<arch>/pi-codex-voice`, relative to the package's emitted entry point, with `.exe` on Windows. There is no ambient binary discovery or automatic device launch. Supply a minimal audio environment without provider secrets.

Use `startDictation(context)` and `finishDictation()` for local dictation. The `draft` presentation event contains text for your editable composer. `stopVoice()` cancels either mode. `listDevices(context)` returns native microphone and speaker choices. Save their IDs with `configure(config)` before the next start. The app owns buttons, shortcuts, push-to-talk timing and its editor.

Settings are instance-local unless you pass a `settings` store with `read` and `write`. `getConfig()` returns the current normalized settings. Saving does not modify an established call. Primary voice defaults to `cove`, alternate handoff voice to `ember`. Resume and post-compaction refresh default to off.

For scoped preferences, pass `preferences: { storage, writeScope: "project" }` instead of `settings`. The explicit storage capability must use the ID `howaboua.gippity-voice`. `@howaboua/pi-durable-settings` supplies the shared contract and an optional JSON file adapter at its `/node` entry point. The app grants exact global and optional project roots. The component never discovers settings directories or stores credentials.

`voice.settingsContribution` and `voice.controls.settingsContribution` expose the same contributor. Await `read()` for defaults, separate overrides, effective values, sources and a revision. Defaults are merged with global preferences, then project preferences, independently within `voice` and `lan`. The contribution accepts partial objects and rejects unknown keys, invalid types and unsupported choices. Optional device IDs, context model, custom app path and LAN port accept `null` to clear an inherited value. Required fields do not.

Save a scope with `replaceOverride({ scope, value, expectedRevision })`. A `null` scope value restores inheritance for that whole scope. Invalid persisted settings, unavailable scopes, storage failures and stale revisions are reported rather than silently falling back. Save results report `next-use`: active calls retain their snapshots. Read the saved effective snapshot for the next call's settings.

`configure(config)`, `configureVoice(patch)` and browser settings controls use this same storage and the selected `writeScope`. Only changed effective fields become overrides, so saving a displayed full config does not pin unchanged inherited fields. `configureVoice` accepts `undefined` for an optional field to clear it. `getConfig()` is synchronous and shows the instance's current settings, initially `config` until preferences have been loaded by service startup or a configure operation. Use the contribution's asynchronous `read()` to inspect persisted settings before startup.

Use a stable, unique `instanceName` for each component when installing more than one GipPity instance in the same registry. Each instance binds to one conversation. `providerEnv` supplies explicit proxy settings such as `https_proxy` and `no_proxy`. Ambient process proxy variables are not consulted.

## Context, LAN and handoff

Context summaries are off by default. Set `allowContextSummary: true` and select `voice.contextModel` only after authorizing conversation export to that Models provider. Reasoning defaults to `high`. Generated summaries are displayed and persisted separately from ordinary model history. Failed refresh leaves the established call intact. The realtime backend never changes the Durable conversation's selected model.

LAN control requires a `lan` capability with the matching namespace, TLS key and certificate, bind address, port, and exact allowed HTTPS origins. `startLan(context)` returns the supplied advertised URLs. The server validates Host and Origin. This is trusted-network control, not an internet-safe authenticated service. Do not expose its port publicly. `stopLan()` ends its browser-owned audio but leaves unrelated local audio alone.

For custom static apps, pass an `appFiles` capability and set `lan.customWebApp` with `lan.customWebAppPath`. `createNativeGippityAppFiles` accepts explicitly approved roots and checks real-path containment and asset bounds. Other execution environments supply their own namespace-bound reader. `registerRemoteApp(provider)` publishes one active app's bounded state and events at `/_gippity/apps/<id>/`. The returned function unregisters it. The bundled `GippityRemote` browser client supports audio, shared drafts, app events and `durable:<event>` activity.

Remote JSON controls use your explicit `rpc` callback. Only authorize named operations your app intends to expose. There is no arbitrary Pi API forwarding. Ordinary tools remain normal Durable registrations and are invoked by the delegated agent.

The app's approval UI can call `activityWaiting(title)` and `activityPromptEnded()` to keep browser activity aligned with its prompts. Durable does not emit app UI prompt events.

`depart(channel, context)` and `arrive(channel, continuity, context)` require an application `handoff` grant for an authenticated ordered channel and the target conversation. GipPity accepts WebRTC handoff only. Incompatible PCM transport is rejected before departure. The source retains the physical audio lease until its transferred peer closes. The destination owns provider auth, work admission and a separate channel grant. Each successful handoff flips primary and alternate voice. Reconnect and context refresh preserve that selection.

Call `close(context)` before changing the component's target. Harness shutdown also cancels its background-owned service. Interrupted calls are reported as uncertain and never replayed after reopening storage. Start again explicitly. If process termination cannot be confirmed, ownership is retained and cleanup fails visibly.

To rebuild a helper deliberately, run `npm run build:native` from the installed package with Rust and the platform's audio build dependencies. This builds only the current target. Native source, its lockfile and vendored notices are included. See `NOTICE` for source revisions and attribution.
