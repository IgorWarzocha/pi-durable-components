# Git and UI SDK

The source boundary is Howcode at `5c7a4e2b75c3682ce8aeb911f4dc425693507508`. Native read behavior comes from `components/git/service/directory-git/worktree-snapshot.ts`, `git-runner.ts`, `file-content.ts` and the image-read portion of `commit-context.ts`. Renderer defaults and lifecycle contracts come from the Git diff UI and trusted package host. The source checkout was read-only. Both new packages preserve its MIT notice.

## Preserved behavior

- Tracked worktree snapshots use a private index and `add -u`. Untracked-inclusive snapshots use `add -A`. Diffs retain one context line, rename detection and canonical `a/` and `b/` prefixes. User index and worktree bytes are unchanged.
- Diff, statistics, full-text context, image preview and baseline tree capture share one native reader. Howcode retains baseline selection, application events and authorization. Snapshotting writes unreachable Git objects. It is not a promise of zero filesystem writes.
- Text reads retain typed unavailable reasons, the 4 MiB limit, UTF-8 validation and SHA-256 revisions. Image previews retain supported MIME types, the 12 MiB limit and nullable result. File-write callers reuse the same path and revision helpers.
- The composable renderer forwards Pierre's generic metadata, ref, slots, controlled or initial items, selection, editing and context-loading props. Host annotations, edit state, image controls, collapse state and scroll ownership stay with the host. Worker sizing, themes and parser fallback semantics are preserved.
- Trusted mounts retain the `{ id, revision, signal, call }` context. The SDK owns child cancellation and exactly-once cleanup, including late asynchronous mounts. Hosts own module loading, authentication, revisions, transport and error presentation.

## Deliberate boundaries

Native construction explicitly grants local Git and filesystem authority. `git_diff` resolves its cwd through the invocation environment and requires a reader bound to that environment. It never substitutes the native host for an unbound namespace. The registration is ordinary Durable integration, also discovered by Code and Notebook.

Every snapshot has its own index, so no shared index lock or stale-lock scavenging remains. Cancellation settles owned processes before index removal. Revisions resolve to immutable trees before diff and blob reads. Numstat uses NUL framing for unusual paths. External diff and textconv hooks are disabled. Git clean filters can still run while snapshotting, as in the source. Worktree reads use bounded file handles and check identity afterward. Image paths now reject traversal and absolute paths instead of stripping a leading slash. Cancellation and resource failures remain visible rather than being silently converted to unavailable results.

The root UI entry imports no framework. `/react/diff` is optional and uses browser-safe Git contracts. Native Git imports no UI. Durable peers are optional for native-only consumers, while React and Pierre peers are optional for lifecycle-only consumers. The only allowed cross-component dependency is UI to Git contracts.

The standalone `mountDiff` view is read-only. It does not limit the SDK to read-only components. The low-level `mountUi` JSON call contract does not itself stream or cancel remote IO. The independent Git HTTP example explicitly wires transport disconnects to native Git cancellation.

## Universal interactive contract

The initial diff extraction was not a complete universal SDK. The shared API now defines `UiComponent<State>`, `UiBinding` and `mountComponent` independently of Git, React and Durable runtime imports. A component validates its own state and declares its actions and streams. The host supplies authorized capabilities, discovery, placement and persistence. Git comments and other component interactions use the same boundary. There is no component-name switch in the SDK.

State snapshots carry monotonically increasing sequence numbers. Subscription precedes the initial read, stale snapshots cannot roll state back, and invalid live state closes the session. `connectUiBinding` hydrates from a host transport whose first snapshot and subsequent updates share one subscription. Disconnects are visible failures, not automatic reconnects.

Actions and async streams receive composed session and per-request abort signals. Cancellation can stop one operation without unmounting the component. Disposal releases subscriptions and stream iterators and waits for exactly-once component cleanup, including late mounts and reentrant abort listeners. Hosts must honor signals to unblock IO. Cancellation does not roll back side effects or authorize retries. Client declarations are not an authorization boundary.

`examples/component-ui` exposes a Git review capability behind an authenticated HTTP transport. The review capability owns revision, path, side and line anchors and stores comments outside the viewer. The example deliberately does not implement a full review product, automatic comment rebasing or a layout engine. Existing tool arguments and results remain unchanged.

## Shared capability presentations

`bindCapability` owns one validated state subscription independently of rendering. Named `UiPresentation` descriptors project that state into stable summary or detail models. Headless `present` sessions support custom framework controls, while `mountPresentation` adds optional DOM ownership. Existing `mountComponent` and `mountUi` remain supported through the same lifecycle implementation.

Presentation requests are validated against the view's declared targets and the capability's available presentations. Only the host performs the transition. Disposing a presentation cancels its work without closing sibling views or the shared binding. Disposing the capability joins child renderers and streams. Git's browser-safe descriptors select statistics or nullable detail without acquiring either. The host retains demand loading, placement, loading indicators and errors.

## Validation

Disposable real-Git probes exercised staged and unstaged edits, untracked files, renames, unusual paths, canonical prefixes under hostile prefix configuration, unchanged user index, concurrent snapshots, text hashes, traversal and external symlinks, image limits, pre-abort and in-flight cancellation, throwing chunk callbacks, stdout limits and filter descendant termination. Node and Bun probes passed. No new permanent tests were added.

Actual Durable invocation passed directly and through Code's V8 runtime and Notebook's Deno runtime. An unbound environment was rejected. The user index remained unchanged. SDK probes covered late mounts, pre-abort, repeated disposal, visible cleanup failures and stale RPC responses.

The independent `examples/git-ui` host used public built package entries and a real repository. Browser checks covered rendering, owned DOM removal on unmount, remount, layout and scoped theme values. Howcode consumes built artifacts rather than source paths and validates its existing read/write security contract against the adapter.

The monorepo delivery gate passed on 2026-10-08: all 28 retained tests, strict TypeScript 7, Biome, Knip, fourteen builds and dry-pack checks. Frozen installation with scripts disabled passed. An independent review inspected native ownership, security and parity, SDK cleanup, Pierre prop forwarding and the emitted browser dependency graph without establishing a material finding. Browser inspection included a narrow viewport, light and dark rendering, visible keyboard focus and layout selection. These checks are delivery evidence, not new permanent UI assertions.

These packages are version 0.1.0 local-development artifacts. They have not been published. Consumer release packaging and non-Linux native behavior are not validated by this change.

The universal SDK follow-up was independently reviewed and exercised on 2026-10-08. Disposable probes covered snapshot hydration and ordering, invalid state, per-operation cancellation, late results, suspended stream closure, subscription failures and reentrant disposal. Review found and corrected duplicate cleanup on reentrant abort, split UTF-8 request decoding and header-like diff content being mistaken for file metadata. No permanent tests were added.

The independent browser host saved a UTF-8 comment and loaded that comment after a server restart. Notebook's speculative browser demo and presentation contract were subsequently removed. The Git review host remains.

Lint, fourteen builds, strict TypeScript, Knip, fourteen dry packs and frozen installation passed. The unchanged 28-test suite passed with Node's `--test-concurrency=1`. The default parallel run passed 27 tests but timed out in the existing Code output-budget test at 10 seconds on two runs; that same test passed alone in 137 ms. No Code, shared execution or test-runner source changed. The default umbrella gate is therefore not reported as green. This parallel-suite limitation remains separate from the SDK work.

The presentation split subsequently passed the full default `bun run check`, including all 28 tests and fourteen dry packs. Independent lifecycle review found a same-turn disposal race that could skip waiting for stream cleanup. The corrected source probe verified disposal waits for delayed iterator return exactly once. Browser checks against the built SDK retained saved Git comments and drafts. The 390px view had no horizontal overflow. These were disposable checks, not additional permanent tests.
