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

The standalone diff view is read-only. It does not replace richer host editing and review workflows. Generic JSON calls do not stream or cancel remote IO. Abort prevents new calls and rejects stale responses. The independent HTTP example explicitly wires transport disconnects to native Git cancellation.

## Validation

Disposable real-Git probes exercised staged and unstaged edits, untracked files, renames, unusual paths, canonical prefixes under hostile prefix configuration, unchanged user index, concurrent snapshots, text hashes, traversal and external symlinks, image limits, pre-abort and in-flight cancellation, throwing chunk callbacks, stdout limits and filter descendant termination. Node and Bun probes passed. No new permanent tests were added.

Actual Durable invocation passed directly and through Code's V8 runtime and Notebook's Deno runtime. An unbound environment was rejected. The user index remained unchanged. SDK probes covered late mounts, pre-abort, repeated disposal, visible cleanup failures and stale RPC responses.

The independent `examples/git-ui` host used public built package entries and a real repository. Browser checks covered rendering, owned DOM removal on unmount, remount, layout and scoped theme values. Howcode consumes built artifacts rather than source paths and validates its existing read/write security contract against the adapter.

The monorepo delivery gate passed on 2026-10-08: all 28 retained tests, strict TypeScript 7, Biome, Knip, fourteen builds and dry-pack checks. Frozen installation with scripts disabled passed. An independent review inspected native ownership, security and parity, SDK cleanup, Pierre prop forwarding and the emitted browser dependency graph without establishing a material finding. Browser inspection included a narrow viewport, light and dark rendering, visible keyboard focus and layout selection. These checks are delivery evidence, not new permanent UI assertions.

These packages are version 0.1.0 local-development artifacts. They have not been published. Consumer release packaging and non-Linux native behavior are not validated by this change.
