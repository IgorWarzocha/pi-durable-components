# Context management

The accepted policy is local notes plus retained history. Every normal rollover checkpoints before starting a clean window. Idle uses that same path. Compaction is reserved for emergency overflow.

## Sources and deliberate changes

The source is `howaboua-pi-stuff` at `5dc8fa4bbded063f9c158e2af7a8a53eeaea7fbb`, particularly `packages/pi-codex-conversion/src/context-management`. The read-only checkout also contained the evolving idle checkpoint changes in `window-kickoff.ts` and `window-manager.ts`. Their inspected diff had SHA-256 `fb6aa893b0fe756599a0f6f447b3acd1c45ed6e5fea35a2fede6dabdd9e2e1d3`. That local delta requires fresh checkpoint notes before an idle cut and distinguishes failed checkpoints from cancelled ones. The package retains the source MIT notice.

The port deliberately excludes Codex accounts, encrypted compaction state, remote and tree backends, shared agent note paths, configurable continuity modes and Pi TUI commands. Notes use the conversation-local `/notes` root. There is no backend selector or second transcript database. Forks inherit note bodies and metadata as of their fork entry, but start with independent window and admission state.

## Storage and lifecycle

Ordinary tools implement the source action names, case-sensitive substring searches, filters, bounded previews and offset retrieval. History reads fork-aware Durable entries in pages, including entries behind the active head. Item IDs are stored entry IDs, and windows have UUIDs. Image bodies are omitted from history text. Notes use rewindable per-path document families with a bounded catalog. Body, catalog, freshness and the original write receipt commit together. Replayed append results cannot append twice or refresh old freshness.

The component uses the official Durable 1.0.2 storage and public task APIs. `management.submit` durably saves the original input before admission. Each input retains its content, attachments and native busy policy. Stable request IDs deduplicate admission and internal checkpoint submissions. A FIFO gate releases as soon as an input reaches native admission, rather than serializing complete model runs and breaking steer behavior.

Settlement observation and the managed task's outcome commit together. The stored timestamp is observation time, not an invented native completion timestamp. A crash before this commit produces a later observation after recovery, delaying the idle cut. The 25-minute deadline also requires the same latest input identity and no live foreground work.

Rollover waits for the actual native submission and foreground cells. A head cut and new logical window identity commit together only after an idle recheck. Initialization appends a non-head marker and never cuts an existing transcript. The old entries, conversation ID, notes and live execution runtimes remain available. Native overflow compaction changes the active model context without changing the logical window UUID.

Failed checkpoints retain original input for an explicit retry or a new user message. Cancelled checkpoints cancel held messages instead. Cancellation intent commits before the rollover claim and admission gate are released. Managed requests follow tool-triggered continuations and cancel linked work across admission and observation handoff gaps.

Installing the extension alone cannot intercept every host input. Direct `Conversation.submit` calls, including agent dispatch and notification inputs, bypass idle admission. Consumers must use the managed entry point for that guarantee. Manual host rollover is `management.newContext`, not an interception of `Conversation.compact`: Durable's compaction hook runs only after native range selection. Normal threshold and manual compactions are declined there; overflow is allowed.

## Tool projection and usage

`new_context` is an ordinary registration carrying the generic `executionHints.nativeOnly` policy. Code and Notebook resolve selected, wrapped registrations from their explicitly bound Harness. Discovery omits native-only tools, nested dispatch rejects them, and provider projection preserves them. A mixed native tool round is rejected before scheduling rollover because Durable's termination control applies only when every result terminates. A standalone call releases the generation before rollover waits for idle.

The usage meter combines the latest applicable assistant counters with the public Pi AI tail estimator. It uses entry ordering, not assistant timestamps. Unknown budgets remain unknown. Compaction invalidates usage from the retired prefix. The 85% and 90% reminders are advisory and deduplicated by logical window, with fresh-note suppression. Prompt bootstrap loads recent note metadata only.

An equivalent first-turn capture with the same Harness, faux model, clock and `Hello` input measured 52 JSON UTF-8 bytes without the extension and 3,082 with it. The four emitted tool declarations occupy 2,565 bytes. The added section contains checkpoint guidance and the current UUID, with no note bodies or archived transcript. These are wire-size measurements, not token counts.

## Evidence

`packages/context/test/context.test.ts` uses the real Harness, official SQLite storage and official faux provider. Only model decisions and interruption timing are scripted. Two retained workflows protect note append replay and original request deduplication across reopen, history retrieval after a clean head cut, failed checkpoint admission held across reopen until explicit retry, and cancellation of multiple held inputs without releasing them or cutting the head.

`test/toolkit.test.ts` exercises Code and Notebook through real V8 and Deno runtimes. Its focused rollover boundary verifies that both modes retain `new_context` on the native offer, omit it from `ALL_TOOLS`, reject nested calls, save notes, cut old provider context and retain live execution state through rollover. It is not an all-tool feature demonstration.

Earlier suite validation also exercised full saved-note bodies and fork snapshots, inherited history references, held attachments across idle checkpoint recovery, final answers after native rollover, linked rollover cancellation, and mixed-round rejection followed by standalone success. Those cases were removed during the contract-spine cull and are historical evidence rather than current suite coverage.

Earlier focused real-Harness probes additionally exercised fork note isolation, meter counters and unknown usage, estimated tails, usage invalidation after an actual compaction marker, 85% then 90% advisory continuations without looping, fresh-note suppression, and actual compaction tasks. Manual and threshold compactions made no summary request. Overflow placed a real summary through the configured provider. Those probes do not claim exhaustive crash-cut coverage or validate any external provider's token accounting.
