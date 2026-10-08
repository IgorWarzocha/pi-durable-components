# Headless presentation evidence

On 2026-10-08, eleven tool packages gained browser-safe `/presentation` exports. [The inventory](../presentations.md) records their scope. These are new host-integration contracts, not extracted Pi rendering. Existing tool registrations, arguments, results, execution engines and cancellation policy are unchanged. Git's existing `/contracts` presentations and the UI SDK remain the shared integration boundary.

The contracts validate host snapshots and project semantic summary/detail data. They do not acquire data or implement tool invocation. Hosts retain authorization, transport, placement and native controls. Nullable detail is distinct from an acquired empty result. Readonly artifact receipts cannot replay operations.

## Focused runtime evidence

Disposable probes exercised these owning paths and the public SDK. They were removed after validation, rather than retained as registration or rendering tests.

- Execution: actual Durable tool dispatch through pinned QuickJS WASM produced running, running and completed receipts, two nested effects and zero active runtimes after cleanup. Code and Worker Code parsers accepted these receipts. Notebook envelope projection, control receipts, script errors, interruption metadata, images and diagnostics were checked separately. Invalid snapshots were rejected, and a 16 MiB image parsed without a recursive-regex failure.
- Notes and Skills: a real Durable Harness invoked notes `write_file`, `list_files_by_prefix` and `read_file`, then Skills `list` and `read`. Actual note results and host-discovered skill metadata fed `bindCapability` and summary/detail presentations. Null-to-loaded publication and disposal passed. The Skills tool's formatted text was not misrepresented as a structured catalog result.
- Artifacts: real patch execution produced a partial-commit failure receipt. The native image codec produced view-image content. Browser artifact storage produced truncated HTML and a continuation cursor. Web normalization accepted empty output. Image artifact persistence produced saved-image metadata and usage. Their snapshots passed SDK binding, lazy detail publication and cleanup. These checks did not call external search or generation providers and do not add new provider-compatibility claims.

The maintained component example now imports Notebook's public `/presentation` instead of owning a second Notebook contract. A browser session ran real Deno through ordinary Durable `ToolTask` calls. It observed retained `count` values 1 and 2 across dismiss/reopen, running-to-completed yield/wait receipts, host-published result streaming, a Notebook status control receipt, and a script error correctly marked alongside the completed cell status. Full unmount completed. At 390 CSS pixels, document width remained within the viewport. Screenshot capture timed out, so no new screenshot-based visual claim is made.

One independent review found that acquired singleton Browser output could contradict the summary's operation count. Parsing now requires one operation for singleton detail and exact array length for batch detail. A focused probe verified rejection while preserving independently projected counts before detail acquisition.

No permanent tests, native runtime changes, new component dependencies or upstream patches were added. The final `bun run check` passed all 28 retained workflows, lint, strict TypeScript, Knip, fourteen package builds and dry-pack checks. Build output bundles the new presentation entries for browsers independently of native runtime entries.
