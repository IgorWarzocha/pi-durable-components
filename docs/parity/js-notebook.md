# JS Notebook parity

## Source and native boundary

The standalone `@howaboua/pi-durable-js-notebook` package adapts `packages/pi-codex-conversion/src/tools/js-mode` at merged PR #552 revision `84bd5bce60a77c4298484d4b7c810d4fe5220a1b`. The source was inspected read-only with `git show`. `NOTICE` preserves its MIT notice. Selected-data graph types, remapping, validation and compaction come from the same revision's TS mode. Unused TS graph capture, replay recipes and merge machinery are not carried.

The native boundary is an ordinary Durable extension and the shared internal cell coordinator. `exec`, `wait` and `notebook` remain unsafe to replay. Selected wrapped registrations are discovered through public Durable APIs and invoked through the coordinator's ordinary nested-tool path. Original tool names, including punctuation, are preserved. The shared internal shell ships in the same package. There is no Pi ExtensionAPI, Pi delegate wrapper, host-private import or per-tool bridge.

## Retained behaviour

QuickJS 3.6.3 runs in owned Node worker threads. Complete VM snapshots preserve lexical environments, closures, classes, instances, aliases and cycles. Atomic images, version fingerprints and the project lease remain intact. Project identity is the nearest Git root or working directory. Conversations sharing the same explicit state directory and project see the same committed VM. The native environment grant must match before files or workers are accessed.

Normal cells remain serial. Four isolated VMs can run alongside the one normal cell, in either admission order. The upstream client's combined four-cell counter was corrected to separate the lanes, matching the accepted contract and shared coordinator. The separate 32-cell bound still rejects uncollected results. Isolated VMs fork committed disk images alongside a running live cell, save named candidates and never adopt automatically. Stale adoption is refused and saves a separately named recovery profile. Whole-VM profiles replace live state, while selected-data profiles preserve existing noncolliding bindings. Pins retain supported plain data across reset. Explicit startup and tool-result hooks retain their ordering and recursion boundary.

Live errors can retain mutations. Interrupted live workers become unavailable until restart. Thread termination handles synchronous infinite loops and infinite promise chains. Restart restores a completed image without replaying cells. Nested tasks remain coordinator-owned and cancellation propagates to ordinary registered tools. Tool and filesystem effects are never rolled back or silently retried.

The runtime is installed through declared exact dependencies rather than a Pi user-directory npm installer. Checkpoints live below the application-supplied state directory, separately from Deno and TS state. The JS VM intentionally has no Node API or module-import bridge. Notebook management stays outside active cells rather than adding a component-specific inner dispatch route.

## Disposable real-runtime evidence

Actual Node 26.12.1 and QuickJS 3.6.3 probes passed:

- Restored a closure, class instance and cyclic object after complete client shutdown. The closure continued its previous counter without replay.
- A real Durable Harness discovered and invoked a punctuated registered tool, performed its side effect once, restarted the VM and retained state without repeating that effect. The same route executed the internal shell tool.
- A yielded Durable cell awaiting an owned registered tool was terminated through `wait`. The nested task observed cancellation. Restart restored the last completed state. Partial text emitted before the blocked tool was visible immediately, and `wait` did not redeliver it. Streaming publications coalesce behind one in-flight durable write.
- Two clients sharing a project refreshed complete committed state. Startup and tool-result hooks ran, plain-data pins survived reset, and whole-VM and selected-data profiles saved successfully.
- An isolated cell forked the old committed value while a live cell held newer uncommitted mutations and awaited a tool. The candidate did not change the live VM. Loading it after the live commit was refused as stale.
- Infinite synchronous execution and an infinite promise chain both terminated within three seconds. Restart recovered only the earlier durable value.
- Five actual kernels remained active with a normal cell followed by four isolated cells, then with four isolated cells followed by a normal cell. A fifth isolated cell and a second normal cell were rejected independently.

No permanent test was added. Focused formatting passed. Focused Knip passed after root configured the shared internal shell dependency declarations.

## Dependency declaration exception

The published `quickjs-wasi@3.6.3` declaration defines `JSException extends Error` with `stack: string | undefined`. This fails TS2415 under strict exact-optional-property checking. Version 3.6.3 is the registry latest. Pi Codemode's public facade does not expose the complete snapshot and handle APIs needed to replace the direct QuickJS boundary.

With Igor's approval, only the JS Notebook package's separate TypeScript compilation uses `skipLibCheck`. Its own source remains strictly checked. The normal repository typecheck runs both the ordinary compilation and this package compilation. This exception skips all dependency declaration checks in the JS Notebook compilation, not only QuickJS. Remove it when upstream publishes a compatible declaration. No installed dependency is patched.
