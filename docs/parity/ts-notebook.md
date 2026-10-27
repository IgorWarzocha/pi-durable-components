# TypeScript Notebook parity

Reference: `IgorWarzocha/howaboua-pi-stuff` merged PR #552 head `84bd5bce60a77c4298484d4b7c810d4fe5220a1b`, read with `git show` from the unchanged source checkout. The carried implementation is `packages/pi-codex-conversion/src/tools/ts-mode`, plus the exact npm cache implementation. `packages/ts-notebook/NOTICE` preserves its MIT notice. Igor explicitly authorised this mode after the earlier TS deferral.

## Native ownership

`@howaboua/pi-durable-ts-notebook` is a standalone package with its own compiler, live worker, portable graph, lifecycle and storage. It uses public Durable extension and tool APIs and the shared internal shell and cell coordinator. It does not emulate Pi's ExtensionAPI, import Pi UI code, require another public component or depend on Howcode. Selected ordinary Durable registrations supply tool names, argument schemas and nested execution. Names are never normalised, including punctuation. Native-only registrations remain outside executable discovery.

The exact compiler dependency is `tsrs@0.20.0-ts7.1.0-beta` with `@types/node@26.6.5`. Dependencies are installed through the package manager, not an implicit first-use runtime installer. The separate emitted `worker.js` owns the live lexical realm and isolated processes. Compiler startup, import compilation and compiler disposal remain separate from worker lifetime.

## Preserved behaviour

- Whole-cell strict checking precedes source execution, including tool argument schemas and previous binding declarations. Top-level await, lexical closures, classes and live handles persist in the normal kernel. Bare values are discarded.
- Successful cells capture portable state without replay. The portable graph retains aliases, cycles, supported built-ins, import identities, named function recipes and explicit snapshot/restore checkpoints. Live-only bindings remain available and are reported when skipped. Pin loss prevents silently replacing the durable checkpoint.
- One live kernel and up to four total active TS cells retain the source heap policy. Isolated workers start from committed portable state and save recovery candidates without adopting into live state. Explicit candidate loading replaces the kernel and reports lost live-only state. Profile loading adds portable bindings and rejects collisions.
- Project pins retain source dependency selection, three-way conflict checks, locked atomic commits and candidate notices. Session state is additionally namespaced by public Durable storage identity and conversation identity. Profiles remain distinct from Deno snapshots.
- Named startup and tool-result hooks retain ordering, awaited execution, startup tool prohibition and recursion suppression. Explicit snapshot/restore helpers are checked before pinning. Lifecycle mutations require idle state. Restart and reset remain usable when the live kernel has failed.
- Cancellation owns the worker process group and cell-owned nested calls. Unsettled tool or import calls fail the cell and invalidate its live kernel. Errors distinguish a cell that never started from uncertain external effects after execution began. No interrupted source is replayed.
- The leading exec pragma, yielding, bounded observations, text and image output, notifications, store/load and tool discovery remain available. Native lifecycle calls inside exec expose only help, status without query, list and diagnostics. Other controls return a top-level retry rather than mutating an active kernel.

The native coordinator persists execution observations and nested-call receipts. It never claims to preserve live workers across host restart. Explicit native environment matching is required before any compiler, worker or filesystem startup.

## Validation

Disposable probes ran the actual installed Rust compiler and emitted Node workers. They exercised persistent nested captured closures and class instances across cells, whole-cell type rejection before a file write, portable restoration without repeating a file effect, named profiles, project pins, explicit snapshot/restore helpers, isolated capture and explicit candidate adoption, startup and tool-result hooks, and punctuation-bearing tool names. A real live-worker termination probe preserved the previous checkpoint and left a single file effect without replay on restart.

A separate real Durable Harness, driven by the official faux provider, exercised an ordinary schema-backed tool, cancellation of an unfinished owned nested call, the explicit failure and uncertain-effect notice, restart after invalidation, and yielded exec/wait continuation without output redelivery. The first probe expected Deno-style successful settlement of an unawaited tool; TS correctly failed it according to the pinned source, and the acceptance assertion was corrected rather than weakening the implementation.

Scoped strict TypeScript and Biome checks passed during implementation. The supported filtered build and dry-pack passed, including the separate worker and public entry import. No permanent test was added. The root delivery gate and external archive acceptance are recorded separately by the integration owner.
