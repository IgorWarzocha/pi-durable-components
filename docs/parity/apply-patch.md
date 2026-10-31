# Apply Patch parity

## PR #558 to #570 reconciliation

Read-only comparison of Pi Stuff `84bd5bce..e4aa5bb43c560b722829a5123b3f2e05d3d9a19d` found a Pi preview extraction from `rendering.ts` into `patch-preview.ts` and Windows helper provenance updates. The patch parser and mutation implementation have no new delta. Native `presentation.ts` already separates host rendering from the environment-scoped executor. No Pi TUI or binary backend is imported.

## Pinned sources

- `IgorWarzocha/howaboua-pi-stuff` at `7f3295e67a8e6146b2a6922b56a06fa4db5c3a32`, package `pi-codex-conversion`.
- Its vendored `openai/codex` apply-patch engine at `83086188ae0614bd882818ff1aa23f3194962012`, verified against `src/tools/rust/UPSTREAM.apply-patch` and the bundled helper's provenance file.
- Durable, pi-ai, and Chord 1.0.2 installed locally. `Type` is imported from pi-ai. No additional runtime dependency or native executable is required.

`packages/apply-patch/NOTICE` carries the Apache-2.0 engine license, OpenAI attribution, MIT adapter license, revisions, and modification notice. Reference checkouts were not edited.

## Implementation and recorded evidence

`createApplyPatchTool()` returns a real Durable `ToolRegistration`. `ApplyPatch` is an optional `defineExtension` bundle. The public tool remains `apply_patch` with `{ input: string }`; `patchText` and `patch` argument aliases are repaired before schema validation. There is no Pi API, TUI import, shim, Code bridge, Notebook bridge, or runtime Rust execution.

| Source behavior | TypeScript owner | Evidence |
|---|---|---|
| Streaming parser's completed-input semantics, Rust Unicode whitespace, heredoc wrappers, one environment ID, exact header errors, blank context, indentation, EOF markers, nonempty updates | `src/parser.ts` | Parser contract and native differential malformed/valid fixtures |
| Exact, trailing-trimmed, fully trimmed, Unicode-normalized search passes; forward-only chunk context; EOF clamp and trailing empty sentinel retry | `src/update.ts` | Matching-tier contract and differential fixture matrix |
| Original context text and terminators retained; inserted lines use first existing ending; resulting lines receive a final terminator | `src/update.ts` | Mixed CR/LF/CRLF and unterminated-file byte comparisons |
| Duplicate resolved sources rejected before mutation, including otherwise empty update sections; multiple hunks in one source section allowed | `src/parser.ts`, `src/executor.ts` | Duplicate and alias contract, guard translated from pinned TS executor |
| Sequential add, update, delete, move, overwrites, missing-parent retry; move writes destination before source removal | `src/executor.ts`, `src/file-mutations.ts` | Operation differential fixtures and injected failed-removal contract |
| Delta reflects committed actions, overwritten contents, symlinks, unreadable/invalid-UTF-8 files, and potentially interrupted effects; `fuzz` reports delta uncertainty, not matching looseness | `src/executor.ts`, `src/file-mutations.ts`, `src/patch-outcome.ts` | Differential delta comparisons plus injected interrupted-write and partial-action contracts |
| All path resolution, metadata, reads, writes, removal, and parent creation through the execution environment | `src/executor.ts`, `src/file-mutations.ts`, `src/mutation-queue.ts` | NodeExecutionEnv integration tests; source has no host filesystem imports |
| Mutation ownership shared across environment objects with equal `id`, canonical aliases, missing paths, and complete multi-path reservations | `src/mutation-queue.ts` | Overlapping-patch and multi-key cancellation tests |
| No side-effect replay after interruption; queue cancellation cannot overtake an earlier owner | Registration and queue | `replay: "unsafe"`, cancellation and interrupted-write contracts |
| Success summary, thrown ordinary failures, partial failure result and recovery instructions | `src/index.ts` | Actual registration execute tests; partial result explicitly sets Durable `isError: true` |
| `PI_EXPERIMENTAL=1` requests `{ type: "json_schema", strict: "prefer" }`; other values leave sampling undeclared | `src/index.ts` | Real Durable generation followed by Responses request serialization, including unsupported-provider fallback |

The native CLI's detailed per-file changes were previously omitted by the TS executor. This component retains them in details without removing the original result arrays or summary. Parsed native actions also give failure targets for heredocs and environment-ID patches that the old TS reporting parser could not decode.

The pinned `tool.ts` and `tools/tool-sampling.ts` declare opt-in strict function sampling, not a patch freeform grammar. Durable's public `ToolRegistration` inherits pi-ai's `constrainedSampling` field and preserves it in transcript declarations. Before the requested unit-test pruning, the sampling test installed the registration in a real Harness, captured its provider-bound transcript, and inspected the serialized HTTP body produced by pi-ai's actual Responses adapter through its supported `fetch` option. Eight captured requests covered the exact environment-value gate, strict schema emission, function-only declaration even when grammar tools are supported, and fallback when strict mode is unsupported. No global fetch patch, network access, credentials, or provider shim was used.

## Validation

Executed on Linux x64 with Node 26.10.0:

```sh
APPLY_PATCH_REFERENCE=<existing-pinned-helper> node --test packages/apply-patch/test/differential.ts
```

Nine deterministic contracts passed before the requested unit-test pruning. Those unit tests are no longer retained. The optional reference suite remains at `test/differential.ts` and compared 196 fixture outcomes with the existing helper. Comparisons include success/failure status, `exact`, every result array, detailed changes, parser errors, and final file bytes. Fixtures cover all search tiers, BOM versus Rust whitespace, mixed terminators, EOF and sentinel boundaries, repeated lines, ordered hunks, malformed markers, heredocs, environment IDs, overwrites, moves, earlier committed actions, valid and dangling symlinks, and invalid UTF-8. Empty input additionally preserves the pinned executor's structured-output failure. Duplicate rejection was checked against the TS guard contract rather than the bare Rust helper, which lacks that guard.

Scoped TypeScript 7.0.2 checking and package emission passed with strict mode, unchecked-index checks, exact optional properties, and erasable-only syntax. Transient dependency-resolution failures during coordinated installation were resolved without weakening compiler options.

The reference suite skips unless `APPLY_PATCH_REFERENCE` names an existing executable. It never compiles a helper, changes reference sources, or writes outside temporary fixtures. Normal tests require no reference checkout.

## Remaining boundaries

- Canonical-path locking is process-local to this component. Durable 1.0.2 does not publicly export its built-in `edit` and `write` mutation queue. Those tools, shell commands, and external processes do not share ownership with this component.
- An unavailable canonical capability falls back to resolved-path keys with a visible diagnostic and `serializationWarnings`. Canonical aliases cannot be guaranteed to serialize in that mode. Lock discovery does not preflight away earlier actions when a later target is inaccessible.
- Filesystem error text and write atomicity come from the selected environment. They are not emulated native OS errno strings. NodeExecutionEnv creates parent directories inside `writeFile`, whereas the native engine does so only for add and move destinations after NotFound. A disappearing update parent can therefore differ in that race.
- Windows and remote environments have not been exercised against a native helper here. Path resolution uses environment capabilities, and Windows drive/UNC keys use ASCII case folding rather than the implementation host's platform. Symlink deletion needs canonical target inspection to reject directory targets safely.
- Pi-only rendering, the `promptSnippet` API and display events are absent. Model-facing guidance is not excluded: the ordinary registration promotes its callable syntax and editing workflow through `executionHints`, which Code and Notebook discover without a bridge. The source owners are `adapter/code-mode.ts` and `prompt/build-system-prompt.ts` at the pinned Pi Stuff revision above. The native call shape remains `{ input: string }`.

The 196-case differential result is evidence for the exercised inputs, not proof over every patch or filesystem race.

## 2026-10-19 source alignment

Inspected read-only Pi Stuff snapshot `7f3295e67a8e6146b2a6922b56a06fa4db5c3a32` against `036dc876da5afc4ec27b64878ebb1cfb30c8211d`.

The source now pins Codex 0.163 apply-patch revision `83086188ae0614bd882818ff1aa23f3194962012`. The engine removes the legacy LF-normalisation mode. This TypeScript implementation already uses the remaining source behaviour: preserve existing context text and terminators, choose the first existing ending for inserted lines, terminate resulting lines, append insertion-only chunks after real source lines, and never search EOF before the current forward cursor. No runtime algorithm change was necessary.

The refreshed path helpers infer double leading separators as Windows UNC, avoid reading cwd for absolute paths, add macOS system-alias support, and expose platform identity without substituting the resolving host for unknown metadata. Here path parsing, absolute resolution and canonical aliases remain owned by the selected Durable environment. No host-platform or host-filesystem inference was copied. Windows UNC parsing and macOS aliases therefore depend on that environment's capabilities, rather than claiming parity through a private path-URI layer.

Validation: the existing differential suite compared all 196 outcomes, deltas, parser errors and final bytes successfully against the pinned Linux x64 helper, whose provenance records the revision above. Source checkout status was clean. No helper was rebuilt and no permanent tests were added.
