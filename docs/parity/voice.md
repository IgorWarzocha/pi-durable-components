# Voice integration evidence

Two independent packages carry the provider-specific voice products. Grok starts from `packages/pi-grok-realtime` at `c988e233932ee8604dff64f59b15618f32b81323`. GipPity starts from `packages/pi-gippity-control` at `69f50cf70e8a7b05c2349be6227f521b6504f80e`. The adopted transfer and alternating-voice delta is pinned at `c7ba4f1398c66d3c10c88c9326c7bddecf0202e1`, PR #490. Grok's documentation framing follows PR #489 at `3f4bd68b9b0f1fe18738252d18eee1a553eb2e86`. Source checkouts remain read-only.

## Native integration boundary

Durable conversations remain the working agents. Provider voice sessions do not replace their selected chat models. Explicit delegation uses ordinary conversation admission. Actual Grok function calls use the generic internal dispatcher for selected ordinary tool registrations. There is no Code or Notebook bridge and no fabricated assistant entry.

Each provider owns its transport, dictation protocol, native helper and LAN controls. The host supplies authorized execution capabilities, credentials through Models, settings, presentation, TLS and network permissions. Context export requires explicit permission. Pi event discovery, terminal rendering, shortcuts and Herdr pane routing are not emulated.

Both packages receive the same application-owned exclusive microphone lease. Voice and dictation reserve ownership before asynchronous startup and release it only after confirmed teardown. Interrupted service tasks report uncertainty rather than reopening microphones or replaying provider calls after restart.

GipPity retains the pinned source's bounded 32-entry context-summary cache. Keys
include the native conversation, effective history, context boundary, selected
model and reasoning. Only successful, still-current summaries are cached. Rebinding
or closing the component clears the cache. Native Durable compaction summaries
are user-message contributions and therefore remain included in both voice
products' existing context builders. Pi-only summary roles are not required to
retain that history.

Transfers require an authenticated, ordered host channel authorized for the target conversation and compatible media transport. Grok uses PCM24 and GipPity uses WebRTC. The source retains its physical audio ownership while forwarding media. The destination receives channel permission, not implied native hardware access. Alternating voice selection survives reconnect and context refresh. Cross-provider media conversion is not supplied.

## Buffered server dictation

The 2026-10-19 Howcode integration adds public `transcribeGippityDictation` and `transcribeGrokDictation` APIs for caller-supplied PCM16 mono audio, plus credential-only readiness checks. These reuse the existing Codex transcriber, Grok STT controller and Models credential resolvers. The accepted input is 100 milliseconds to 600 seconds at 16 or 24 kHz. Only the explicit transcription call opens a provider connection. The wrappers have a 60-second request deadline, do not retry, and require no native capture, context export, voice call, LAN listener or Durable conversation.

Codex adds 16-to-24-kHz interpolation and optional language selection. Grok accepts 16 kHz directly while retaining its native 24-to-16-kHz converter. Early provider failures remain errors when finalisation is requested. The Codex connector owns its upgraded socket through Undici's public dispatcher boundary, joins teardown and forces closure after a two-second grace. Grok retains native WebSocket termination and bounds provider events and transcript text. Readiness may refresh Models credentials but does not establish entitlement or network reachability.

Scoped delivery accepts exact package names after the build command or pack destination, for example `node scripts/workspaces.mjs build @howaboua/pi-durable-gippity-voice @howaboua/pi-durable-grok-voice`. The unfiltered gate is unchanged. No tests or live-service calls were requested for this addition. Validation is limited to static checks, emitted public entries, asset checks and packaging. Howcode owns integration review and authorised running-app acceptance.

Howcode's live Grok acceptance subsequently reported duplicated phrases. Inspection found that the carried partial handler appended both chunk finals and their stitched utterance final. The [xAI STT protocol](https://docs.x.ai/developers/model-capabilities/audio/speech-to-text) distinguishes `is_final` from `speech_final`: an utterance final replaces the pending chunk finals for that utterance. The handler now keeps those separately. It does not deduplicate text or remove genuinely repeated speech. A nonempty `transcript.done.text` remains authoritative and unmodified. This corrects preview assembly and the existing empty-final fallback. Live revalidation belongs to the consuming Howcode app.

## Artifact evidence

All six Grok binaries and their six dependency notices match the carried SHA256 manifest. Every manifest value matches the immutable source pin, with local formatting applied. GipPity's original helpers matched the extraction pin. The native migration below supersedes those six assets. Native Rust source, lockfiles, build scripts and relevant notices remain available for deliberate rebuilding.

Grok's historical native-input fingerprint was independently reconstructed from immutable source objects and matched `1198e206a19b0bb08ba3ce961b333f68926a1ff760a3aefd07cfd0b8b56d0751`. Adapted package-local build and verification scripts retain that upstream stamp as provenance. They do not claim that a local rebuild reproduced the shipped binaries.

The shared package gate copies native assets into emitted package locations and rejects missing targets, missing notices, changed bytes and duplicate source binary distribution. It does not execute foreign binaries or open audio devices.

Grok's disposable checks used a real SQLite Harness and loopback provider fixture. They exercised ordinary nested registrations with the conversation environment, acknowledged delegation only after Durable admission, consumed a dictation draft once and stopped owned work. Two stable component instances transferred authenticated PCM across conversations, selected the alternate `ara` voice and sent typed work only to the destination. Capture was reused while the physical lease remained held. Teardown released the channel grant once. Harness shutdown followed by a fresh component and reopened storage did not replay provider or audio startup.

GipPity's disposable lifecycle checks used a real Durable Harness, reopened SQLite storage and real Node helper processes without audio devices or provider traffic. They verified helper closure before lease release after startup failure, channel-grant cleanup after failed arrival, incompatible-media rejection, Harness shutdown during partial startup and no spawn replay after reopening an interrupted service.

Successful GipPity sessions also ran through actual undici V3 requests using an explicit loopback TLS proxy and real helper processes. Duplicate delegation admitted one ordinary Durable input while conversational speech admitted none. Two chained authenticated WebRTC handoffs selected `cove`, then `ember`, then `cove`, and routed typed input to the final conversation. One physical lease survived both transfers and was released after audio closure. All four channel grants were released, with no credentials passed to helpers or channels. These checks used no external provider traffic.

The GipPity loopback LAN check exercised real HTTPS, WebSockets and SSE. Host and Origin checks rejected unauthorized requests. Authorized static-app reads rejected symlink escape and preserved literal percent characters. Browser PCM reached the helper. Takeover reused the backend and lease, disconnect left the call running, and stopping LAN joined the helper before releasing ownership. Initial events exposed neither credentials nor old conversation history.

Independent review found that arrival failure before channel-link construction left the source waiting for its preparation timeout. The corrected failure path closes the incoming channel immediately and guarantees local cleanup. A disposable real Harness check verified credential-preparation failure and a throwing channel close, with channel grants released in both cases and no hardware acquired.

Live xAI and Codex entitlement, microphone permissions, acoustic behavior, device compatibility, LAN access and non-Linux execution remain unverified. Artifact integrity and offline lifecycle checks do not establish those external boundaries. Final package integration validation is recorded in the root parity report.

Both emitted voice archives passed an isolated npm consumer's strict TypeScript check without `skipLibCheck`, including a single lease typed for both products, and imported without starting audio or network activity. That consumer pinned AWS and Smithy transitive versions to the repository's existing lock. Unconstrained npm resolution was blocked by an upstream dependency requesting the unpublished `@aws-sdk/credential-provider-http@^3.972.75`. No repository override or upstream patch was introduced to mask that registry failure.

## Native WebRTC migration at merged PR #552

The entire GipPity Rust tree, lockfile and dependency notices now match read-only Pi Stuff `84bd5bce60a77c4298484d4b7c810d4fe5220a1b`, inspected with `git show`. This carries WebRTC `0.17.2` to `0.21.1`, its `rtc` core, Opus `0.4.0` with statically built libopus `1.6.1`, Rubato `5.0.1` and the pinned dependency resolution. Existing OpenAI Codex Apache notices and the source revision in `VENDORED.md` remain intact. The added codec and WebRTC notices ship alongside them.

The integration uses explicit peer-event handlers and polled data-channel events. Remote playout and data reception belong to a session-owned worker set. Offer failure closes the partially constructed peer before application workers start. Teardown marks the session closing, cancels and joins encoding and event workers, then closes the peer. Data-channel closure disables input. Remote-track callbacks schedule owned work without blocking the peer driver. RTP output reads the negotiated Opus payload type from sender parameters rather than assuming the offer's payload number. Capture and playback retain their existing processing and speaker-epoch boundaries in separate modules. The JSONL protocol remains version 6 and host-native execution remains an explicit capability.

Linux x64 was rebuilt with the supported `node scripts/build-voice-helper.mjs` path, which runs `cargo build --release --locked`. Independent review found that this machine's glibc 2.44 produced an executable requiring glibc 2.43, above the previous 2.34 baseline. The shipped Linux x64 asset was therefore replaced by the matching immutable `84bd5bce` binary, which requires at most glibc 2.34. All six shipped target binaries come from that source revision. Foreign targets were not locally rebuilt.

The shipped Linux x64 binary was then exercised through real bridge start, offer, stop and shutdown. Its source hash is `a73d795f8c1bc14384537766fd1ba197f7adb2d45c44fb943fc1b84c502ed9d9`.

A disposable check ran the locally rebuilt Linux helper through four bridge offer cycles, input muting, speaker suppression transitions, PCM submission, malformed-answer failure and joined stop. Each stop returned the process to six open descriptors. Closing stdin during an active bridge also exited successfully. These checks opened local WebRTC sockets, but no audio device or external provider. Negotiated media exchange, acoustic behaviour, provider entitlement, device compatibility and execution on the other five targets remain unverified by this migration check. No permanent tests were added.

## PR #552 refresh

Traced read-only Pi Stuff `a06eae4d..1338b66a1067c254fec46746ef96b6bd9456148b`. GipPity call setup now requests `gpt-live-1.1-codex`. The source's summary projection moves from Conversion-owned tree projection to the Notes public projection. Native summaries already consume `conversation.context()`, including native replacement summaries, and key their bounded cache by effective text, head, model and reasoning. They re-read that projection before caching and reject changed history rather than caching stale output.

`GippityVoiceControls.refreshContext(signal?)` is the explicit host boundary for refreshing an active call before retiring its outgoing context window. It serialises with voice controls, follows the active `refreshRealtimeAfterCompaction` setting, forces a fresh summary and honours cancellation. The host must await it before cutting the head. Existing native `compaction_end` handling still waits for the completed compaction submission before refreshing. Summary failure retains the established call and reports the error. Replacement failure stops the owned session rather than silently falling back. Context owns rollover admission and saved-note projection, not a voice-specific bridge. This does not claim parity with Pi's in-flight speech drain or held-delegation refresh machinery.

Grok now carries the source `stay_quiet` function, reserved-name rejection and quiet-turn timer. A quiet receipt does not demand speech. A configured silence interval can reconsider it, while muting, agent work, new context, speech and teardown cancel stale timers. Landed-update receipts no longer include a redundant timestamp. The session retains its existing actual-socket teardown and native task ownership. Dictation has no behavioural delta in this source range. GipPity's prompt changes are whitespace only, so no user or bundled voice prompt was rewritten.

A disposable probe exercised the production Grok session against an actual loopback WebSocket server. It verified quiet-tool advertisement and receipt, no immediate continuation, delayed reconsideration, mute cancellation, timestamp-free landed context and joined teardown. It also checked the actual GipPity call-request builder selects live 1.1. Focused Biome and diff-whitespace checks passed. No permanent tests, provider calls or audio devices were added. Active GipPity rollover replacement remains source-reviewed rather than newly runtime-validated. The root coordinator owns Context composition and the final repository gate.

Both voice options accept `projectContext({ conversationId, view }, context): Promise<ContextView>`. This explicit, host-owned projection can restore authorised retained checkpoint messages or add saved notes before summarisation. It runs only with context export enabled and a context model selected. GipPity repeats the projection before caching, so a changed saved note invalidates the in-flight summary. Callback failure remains visible and never falls back to incomplete native history. Neither voice package imports Context or reads a private checkpoint store.

For a host composing Context notes, the callback can use its authorised storage view:

```ts
async projectContext({ conversationId, view }, context) {
  const notes = await readSavedNotes(storage, conversationId, context);
  if (!notes.length) return view;
  return {
    ...view,
    messages: [{
      role: "user",
      content: `Saved continuity notes, background history only:\n${notes
        .map(note => `${note.path}\n${note.text}`).join("\n\n")}`,
      timestamp: 0,
    }, ...view.messages],
  };
}
```

The host imports `readSavedNotes` from Context, selects the authorised conversation and enforces its own export size policy. This notes composition is not a reconstruction of the source's archived tree ancestry. Hosts that retain checkpoint messages can provide those through the same projection instead. Focused strict TypeScript passed for both voice public entries and Board. This does not add live-provider or active-call acceptance.
