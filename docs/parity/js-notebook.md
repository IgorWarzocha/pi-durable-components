# JS Notebook parity

## PR #561 alignment

The read-only comparison `84bd5bce60a77c4298484d4b7c810d4fe5220a1b..e4aa5bb43c560b722829a5123b3f2e05d3d9a19d` carries PR #561 input normalisation through the shared ordinary nested-registration path. The source's injected validator avoids Pi loader aliases, which are absent here. No JS-specific bridge is needed. A disposable actual Durable and native JS VM probe accepted JSON object strings, help, literal strings and configured command objects and arrays. Notebook help, status, list and diagnostics remained callable through ordinary registrations. Blocked restart preserved the live value. VM persistence and project-sharing contracts are unchanged.

## Source and native boundary

The standalone `@howaboua/pi-durable-js-notebook` package adapts `packages/pi-codex-conversion/src/tools/js-mode` at merged PR #552 revision `84bd5bce60a77c4298484d4b7c810d4fe5220a1b`. The source was inspected read-only with `git show`. `NOTICE` preserves its MIT notice. Selected-data graph types, remapping, validation and compaction come from the same revision's TS mode. Unused TS graph capture, replay recipes and merge machinery are not carried.

The native boundary is an ordinary Durable extension and the shared internal cell coordinator. `exec`, `wait` and `notebook` remain unsafe to replay. Selected wrapped registrations are discovered through public Durable APIs and invoked through the coordinator's ordinary nested-tool path. Original tool names, including punctuation, are preserved. The shared internal shell ships in the same package. There is no Pi ExtensionAPI, Pi delegate wrapper, host-private import or per-tool bridge.

## Retained behaviour

QuickJS 3.6.3 runs in owned Node worker threads. Complete VM snapshots preserve lexical environments, closures, classes, instances, aliases and cycles. Atomic images, version fingerprints and the project lease remain intact. Project identity is the nearest Git root or working directory. Conversations sharing the same explicit state directory and project see the same committed VM. The native environment grant must match before files or workers are accessed.

Normal cells queue on the source client's live queue and execute serially in one VM. Up to four normal cells, including queued cells, are admitted. Cancelling a queued cell settles promptly without executing its source or releasing a successor ahead of the running cell. Four isolated VMs can run alongside the normal lane, in either admission order. The upstream client's combined four-cell counter was corrected to separate the lanes, matching the accepted isolated-concurrency contract. The separate 32-cell bound still rejects uncollected results. Isolated VMs fork committed disk images alongside a running live cell, save named candidates and never adopt automatically. Stale adoption is refused and saves a separately named recovery profile. Whole-VM profiles replace live state, while selected-data profiles preserve existing noncolliding bindings. Pins retain supported plain data across reset. Explicit startup and tool-result hooks retain their ordering and recursion boundary.

Live errors can retain mutations. Interrupted live workers become unavailable until restart. Thread termination handles synchronous infinite loops and infinite promise chains. Restart restores a completed image without replaying cells. Nested tasks remain coordinator-owned and cancellation propagates to ordinary registered tools. Tool and filesystem effects are never rolled back or silently retried.

Inside cells, the ordinary `notebook` registration accepts `tools.notebook({action,...})`. Help, status without a query, list and diagnostics retain the source contract. Other valid requests return `details.notRun` and the retry request without performing a management operation. Invalid requests fail validation. Calls use the same selected registration, nested ownership and hooks as other tools, not a component-specific bridge.

Runtime loading first reuses the exact installed packages. Missing or mismatched versions use the source's exact-version install-and-cache fallback beneath the explicit state directory. Installation disables lifecycle scripts and keeps npm's download cache there too. Complete cached payloads work offline. Provisioning failures remain retriable rather than latching a failed notebook identity. Checkpoints live below the application-supplied state directory, separately from Deno and TS state. The JS VM intentionally has no Node API or module-import bridge.

## Disposable real-runtime evidence

Actual Node 26.12.1 and QuickJS 3.6.3 probes passed:

- Restored a closure, class instance and cyclic object after complete client shutdown. The closure continued its previous counter without replay.
- A real Durable Harness discovered and invoked a punctuated registered tool, performed its side effect once, restarted the VM and retained state without repeating that effect. The same route executed the internal shell tool.
- A yielded Durable cell awaiting an owned registered tool was terminated through `wait`. The nested task observed cancellation. Restart restored the last completed state. Partial text emitted before the blocked tool was visible immediately, and `wait` did not redeliver it. Streaming publications coalesce behind one in-flight durable write.
- Two clients sharing a project refreshed complete committed state. Startup and tool-result hooks ran, plain-data pins survived reset, and whole-VM and selected-data profiles saved successfully.
- An isolated cell forked the old committed value while a live cell held newer uncommitted mutations and awaited a tool. The candidate did not change the live VM. Loading it after the live commit was refused as stale.
- Infinite synchronous execution and an infinite promise chain both terminated within three seconds. Restart recovered only the earlier durable value.
- Five actual kernels remained active with a normal cell followed by four isolated cells, then with four isolated cells followed by a normal cell. A fifth isolated cell was rejected independently.
- A further real Durable Harness probe queued normal cells behind a blocked live cell, enforced the four-normal admission bound, cancelled queued cells promptly, then observed the next normal cell consume the preceding commit. Four isolated kernels remained blocked concurrently with the live lane and queue. Cancellation prevented queued tool effects.
- In-cell help, status, list and diagnostics returned their message/details shape. Reset and queried status returned `notRun`, an invalid action failed, and the live binding remained unchanged. Ordinary owned-tool cancellation and restart preserved the last commit without repeating side effects. Closing with live, queued and isolated cells active completed and joined cleanup.
- The same fresh-state Harness saved selected-data and whole-VM profiles, retained plain-data pins across reset, restored a closure from the whole-VM profile and shared its next mutation with another conversation in the same project.
- Mistaken `wait` calls with real numeric shell session IDs continued through the ordinary `write_stdin` registration. Repeated polls delivered distinct chunks once and the exit code. Termination did not take this recovery route. Unknown process IDs retained the unknown-cell failure.
- A disposable runtime bundle outside installed package resolution provisioned the exact Pi Codemode and QuickJS packages into its empty state directory. Offline reuse succeeded with an unreachable registry. An empty offline cache reported `RuntimeInstallError`, and retrying the same loader after restoring registry access succeeded.

No permanent test was added. Focused formatting passed. Focused Knip passed after root configured the shared internal shell dependency declarations.

## Dependency declaration exception

The published `quickjs-wasi@3.6.3` declaration defines `JSException extends Error` with `stack: string | undefined`. This fails TS2415 under strict exact-optional-property checking. Version 3.6.3 is the registry latest. Pi Codemode's public facade does not expose the complete snapshot and handle APIs needed to replace the direct QuickJS boundary.

With Igor's approval, only the JS Notebook package's separate TypeScript compilation uses `skipLibCheck`. Its own source remains strictly checked. The normal repository typecheck runs both the ordinary compilation and this package compilation. This exception skips all dependency declaration checks in the JS Notebook compilation, not only QuickJS. Remove it when upstream publishes a compatible declaration. No installed dependency is patched.
