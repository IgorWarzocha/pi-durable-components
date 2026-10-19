# Voice integration evidence

Two independent packages carry the provider-specific voice products. Grok starts from `packages/pi-grok-realtime` at `c988e233932ee8604dff64f59b15618f32b81323`. GipPity starts from `packages/pi-gippity-control` at `69f50cf70e8a7b05c2349be6227f521b6504f80e`. The adopted transfer and alternating-voice delta is pinned at `c7ba4f1398c66d3c10c88c9326c7bddecf0202e1`, PR #490. Grok's documentation framing follows PR #489 at `3f4bd68b9b0f1fe18738252d18eee1a553eb2e86`. Source checkouts remain read-only.

## Native integration boundary

Durable conversations remain the working agents. Provider voice sessions do not replace their selected chat models. Explicit delegation uses ordinary conversation admission. Actual Grok function calls use the generic internal dispatcher for selected ordinary tool registrations. There is no Code or Notebook bridge and no fabricated assistant entry.

Each provider owns its transport, dictation protocol, native helper and LAN controls. The host supplies authorized execution capabilities, credentials through Models, settings, presentation, TLS and network permissions. Context export requires explicit permission. Pi event discovery, terminal rendering, shortcuts and Herdr pane routing are not emulated.

Both packages receive the same application-owned exclusive microphone lease. Voice and dictation reserve ownership before asynchronous startup and release it only after confirmed teardown. Interrupted service tasks report uncertainty rather than reopening microphones or replaying provider calls after restart.

Transfers require an authenticated, ordered host channel authorized for the target conversation and compatible media transport. Grok uses PCM24 and GipPity uses WebRTC. The source retains its physical audio ownership while forwarding media. The destination receives channel permission, not implied native hardware access. Alternating voice selection survives reconnect and context refresh. Cross-provider media conversion is not supplied.

## Buffered server dictation

The 2026-10-19 Howcode integration adds public `transcribeGippityDictation` and `transcribeGrokDictation` APIs for caller-supplied PCM16 mono audio, plus credential-only readiness checks. These reuse the existing Codex transcriber, Grok STT controller and Models credential resolvers. The accepted input is 100 milliseconds to 600 seconds at 16 or 24 kHz. Only the explicit transcription call opens a provider connection. The wrappers have a 60-second request deadline, do not retry, and require no native capture, context export, voice call, LAN listener or Durable conversation.

Codex adds 16-to-24-kHz interpolation and optional language selection. Grok accepts 16 kHz directly while retaining its native 24-to-16-kHz converter. Early provider failures remain errors when finalisation is requested. The Codex connector owns its upgraded socket through Undici's public dispatcher boundary, joins teardown and forces closure after a two-second grace. Grok retains native WebSocket termination and bounds provider events and transcript text. Readiness may refresh Models credentials but does not establish entitlement or network reachability.

Scoped delivery accepts exact package names after the build command or pack destination, for example `node scripts/workspaces.mjs build @howaboua/pi-durable-gippity-voice @howaboua/pi-durable-grok-voice`. The unfiltered gate is unchanged. No tests or live-service calls were requested for this addition. Validation is limited to static checks, emitted public entries, asset checks and packaging. Howcode owns integration review and authorised running-app acceptance.

## Artifact evidence

All six Grok binaries and their six dependency notices match the carried SHA256 manifest. Every manifest value matches the immutable source pin, with local formatting applied. All six GipPity helpers were compared byte-for-byte with `git show` at the extraction pin. Native Rust source, lockfiles, build scripts and relevant notices remain available for deliberate rebuilding.

Grok's historical native-input fingerprint was independently reconstructed from immutable source objects and matched `1198e206a19b0bb08ba3ce961b333f68926a1ff760a3aefd07cfd0b8b56d0751`. Adapted package-local build and verification scripts retain that upstream stamp as provenance. They do not claim that a local rebuild reproduced the shipped binaries.

The shared package gate copies native assets into emitted package locations and rejects missing targets, missing notices, changed bytes and duplicate source binary distribution. It does not execute foreign binaries or open audio devices.

Grok's disposable checks used a real SQLite Harness and loopback provider fixture. They exercised ordinary nested registrations with the conversation environment, acknowledged delegation only after Durable admission, consumed a dictation draft once and stopped owned work. Two stable component instances transferred authenticated PCM across conversations, selected the alternate `ara` voice and sent typed work only to the destination. Capture was reused while the physical lease remained held. Teardown released the channel grant once. Harness shutdown followed by a fresh component and reopened storage did not replay provider or audio startup.

GipPity's disposable lifecycle checks used a real Durable Harness, reopened SQLite storage and real Node helper processes without audio devices or provider traffic. They verified helper closure before lease release after startup failure, channel-grant cleanup after failed arrival, incompatible-media rejection, Harness shutdown during partial startup and no spawn replay after reopening an interrupted service.

Successful GipPity sessions also ran through actual undici V3 requests using an explicit loopback TLS proxy and real helper processes. Duplicate delegation admitted one ordinary Durable input while conversational speech admitted none. Two chained authenticated WebRTC handoffs selected `cove`, then `ember`, then `cove`, and routed typed input to the final conversation. One physical lease survived both transfers and was released after audio closure. All four channel grants were released, with no credentials passed to helpers or channels. These checks used no external provider traffic.

The GipPity loopback LAN check exercised real HTTPS, WebSockets and SSE. Host and Origin checks rejected unauthorized requests. Authorized static-app reads rejected symlink escape and preserved literal percent characters. Browser PCM reached the helper. Takeover reused the backend and lease, disconnect left the call running, and stopping LAN joined the helper before releasing ownership. Initial events exposed neither credentials nor old conversation history.

Independent review found that arrival failure before channel-link construction left the source waiting for its preparation timeout. The corrected failure path closes the incoming channel immediately and guarantees local cleanup. A disposable real Harness check verified credential-preparation failure and a throwing channel close, with channel grants released in both cases and no hardware acquired.

Live xAI and Codex entitlement, microphone permissions, acoustic behavior, device compatibility, LAN access and non-Linux execution remain unverified. Artifact integrity and offline lifecycle checks do not establish those external boundaries. Final package integration validation is recorded in the root parity report.

Both emitted voice archives passed an isolated npm consumer's strict TypeScript check without `skipLibCheck`, including a single lease typed for both products, and imported without starting audio or network activity. That consumer pinned AWS and Smithy transitive versions to the repository's existing lock. Unconstrained npm resolution was blocked by an upstream dependency requesting the unpublished `@aws-sdk/credential-provider-http@^3.972.75`. No repository override or upstream patch was introduced to mask that registry failure.
