# Native dictation extraction

Source: Howcode revision `85db20ee1f156ad3543a8893d46c40e4a0bc5c65`,
`components/dictation/service` and `shared/desktop-dictation-contracts.ts`,
`shared/dictation-{models,helpers,settings}.ts` (MIT).

The package retains the three English Whisper presets, staged downloads,
redirect metadata and checksum verification, atomic replacement with backup
restoration, managed/configured model discovery, selected-model fallback,
PCM16 decoding, async sherpa recognition and structured failure results.
The host supplies the managed model directory, selected model getter and log
callback instead of Howcode settings, user-data paths and desktop events.

Recognizer caches and admitted work belong to each factory instance. Model
mutations and transcription are serialized so replacement cannot race native
decoding. Disposal rejects new/queued native work, aborts downloads and drains
active work before releasing the recognizer cache. Native handles remain
GC-owned; sherpa exposes no supported close API. Install cancellation is checked
before finalization and wired into the stream pipeline; an already-started
atomic finalization is drained, not replayed. Redirect response bodies are
cancelled before following the next URL.

Explicit `modelSearchDirectories`, `language`, `numThreads` and `provider`
options replace app-specific environment aliases in the portable engine.
When those options are omitted, `PI_SHERPA_ONNX_MODEL_DIR`,
`PI_DICTATION_MODEL_DIR` and `PI_SHERPA_ONNX_{NUM_THREADS,PROVIDER,LANGUAGE}`
remain the portable environment defaults. The consuming adapter owns legacy
app aliases and their precedence. An explicit discovery list replaces the
environment roots and appends managed storage. Managed downloads always use
the explicitly supplied directory. Selected managed model priority and
language fallback remain unchanged. Explicit thread counts reject invalid
values before creating the service.
The former `numChats` configuration typo is corrected to sherpa's supported
`numThreads` so the existing thread-count setting actually applies.

`./contracts`, `./models` and `./helpers` are browser-safe. File-path resolution
and all native loading stay in the server entry. sherpa-onnx-node 1.13.8 remains
external, including its platform-specific optional native dependencies.
