# JS Notebook

Persistent JavaScript execution for Pi Durable. Closures, class instances, cyclic objects and lexical bindings survive a host restart through complete QuickJS VM checkpoints. Cells are never replayed to restore state.

The component registers `exec`, `wait`, `notebook`, `exec_command` and `write_stdin`. Ordinary selected Durable tools are available through `tools` inside cells, with their original registered names. It works without Howcode.

## Host setup

```sh
npm install https://github.com/IgorWarzocha/pi-durable-components/releases/download/v0.9.0/howaboua-pi-durable-js-notebook-0.9.0.tgz
```

Use Node.js 22.19 or later. Bun hosts are rejected because worker termination is part of the cancellation boundary. Install the package and its declared Durable peers through your application's package manager. QuickJS and its WASM loader use exact versions. If the installed runtime is unavailable, the component can provision its owned cache on first use and reuse it offline.

Create `createJsNotebookMode` with a `stateDirectory`, `native: { environmentId }`, a matching shell backend and a `cancelTask` callback that calls the owning Harness's `abortTask`. Install its `extension` in your Durable registry, then call `bind(harness)`. Call `close()` when the application shuts down.

`maxHeapMiB` defaults to 4096 and must be at least 128. Half is the live VM budget. Each of at most four isolated VMs receives one quarter of that live budget. An optional `profile` selects initial saved state when the project has no checkpoint.

The execution environment must match the explicit native grant. Checkpoint files use the host filesystem beneath `stateDirectory`. Conversations using that directory and the same project share one serial notebook, including lexical state. Projects are identified by the nearest Git root, or by the working directory outside Git. Use separate state directories when applications must not share state.

Do not install multiple execution modes with the same tool names in one selected agent.

## Cells and saved state

`exec` accepts JavaScript with top-level await. Bare values are discarded. Use `text(value)` or `image(value)` for output. `notify`, `generatedImage`, `store`, `load`, `exit` and `yield_control` are also available. `ALL_TOOLS` describes selected registrations. The VM has no Node globals, filesystem API or module imports. Use registered tools for external operations.

Normal successful cells save the complete VM. A leading `// @exec: {"isolated":true}` forks the last committed checkpoint without sampling a running live cell. Completion saves a named candidate without adopting it. External tool and file effects remain shared.

Call `notebook` without input for its action help. Whole-notebook profiles preserve the entire VM and replace live state when loaded. Selected-data profiles add noncolliding bindings. Pins preserve supported plain data across reset and protect names from release. Closures and class instances survive whole-VM checkpoints, but cannot be selected-data pins.

Startup and tool-result hooks use retained functions. Startup hooks cannot call tools. Failed startup blocks normal execution. Tool-result hooks run after settlement, and calls inside them do not recursively trigger hooks.

## Recovery

`wait` continues a yielded cell or terminates it. Cancellation stops its owned worker, including infinite promise chains. Cancellation does not undo tool effects. A stopped live VM requires `notebook restart`, which restores the last completed checkpoint without replaying side effects. Errors that leave a VM alive can retain earlier mutations.

An isolated candidate cannot silently overwrite newer project state. A stale load is refused and produces a recovery profile for an explicit replacement. `reset` discards the live project VM, while saved profiles and reset-survival pins remain.

Snapshots are runtime-specific, not portable JavaScript serialisations. Preserve the matching runtime version when recovering saved state.
