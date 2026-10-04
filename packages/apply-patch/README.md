# Apply Patch for Pi Durable

Apply Codex-format multi-file patches through the conversation's execution environment. The tool supports additions, updates, deletions, moves, ordered hunks, Unicode-tolerant matching, and mixed line endings. No Rust helper runs at runtime.

```sh
npm install @howaboua/pi-durable-apply-patch @earendil-works/pi-durable @earendil-works/pi-ai @earendil-works/chord
```

Install the bundle in your Durable registry:

```ts
import { createRegistry } from "@earendil-works/pi-durable";
import { ApplyPatch } from "@howaboua/pi-durable-apply-patch";

const registry = createRegistry();
registry.install(ApplyPatch);
```

Pass the registry and an `env` factory to your harness. `NodeExecutionEnv` from `@earendil-works/pi-durable/env/node` is one option. The component never substitutes the host filesystem when `api.env` is missing. Relative paths use the environment's `cwd`; absolute paths use its path convention.

For an existing extension, add `createApplyPatchTool()` to its `tools`. Code and Notebook discover this ordinary registration without a bridge. Remove it with `registry.uninstall(ApplyPatch)`.

Set `PI_EXPERIMENTAL=1` before creating the tool to request strict JSON-schema sampling, matching the pinned source. Providers without strict-schema support still receive an ordinary function tool. The source tool does not declare a freeform grammar.

## Failures and concurrency

File actions run in order, without rollback. If a later action fails, earlier actions remain applied. A move writes its destination before removing its source, so a failed move can leave both files. Partial failures include the committed delta and recovery instructions. Interrupted writes are not retried automatically.

The result's `fuzz` is `0` for an exact filesystem delta and `1` when the delta may be incomplete. It does not measure whitespace matching. Details also include per-file changes and overwritten contents.

Calls from this component serialize overlapping resolved and canonical paths within one process, keyed by filesystem `id`. If canonical paths are unavailable, a diagnostic explicitly reports resolved-path-only locking. This queue does not coordinate with Durable's private built-in `edit` and `write` queue, other processes, or shell commands. Do not run those mutators concurrently against the same files.

The registration is `replay: "unsafe"`. Reopening Durable does not replay an interrupted patch. Read the affected target before deciding what to retry.

Requires Durable, pi-ai, and Chord 1.0.2. Derived engine code is Apache-2.0; adapter code is MIT. See [NOTICE](./NOTICE).
