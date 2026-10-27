# TypeScript Notebook

Strict TypeScript execution for Pi Durable, with a persistent live Node kernel. Keep closures, classes and imported handles between cells. The Rust-backed TS7 compiler checks the whole cell before its source runs, including calls to ordinary selected Durable tools.

The package supplies `exec`, `wait`, `notebook`, `exec_command` and `write_stdin`. It runs independently of Howcode. Select one execution component per agent because Code, Deno Notebook and JavaScript Notebook use the same tool names.

## Host setup

Use a Node.js host, not Bun. Supported platforms are Linux and macOS on x64 or arm64, and Windows on x64. Install optional dependencies so `tsrs` can supply its native compiler. The package requires Pi Durable 1.4.0 and Node 22.19.0 or later.

Workers run native Node processes with filesystem, network and subprocess access in the explicitly matched execution environment. They are not a security sandbox. The shell backend must match the same environment.

```ts
import {
  createNodeShellBackend,
  createTsNotebookMode,
} from "@howaboua/pi-durable-ts-notebook";

const notebook = createTsNotebookMode({
  stateDirectory: "/absolute/path/to/notebook-state",
  native: { environmentId: env.id },
  shell: { backend: createNodeShellBackend({ environmentId: env.id }) },
  cancelTask: (id, context) => harness.abortTask(id, context),
});

registry.install(notebook.extension);
// After opening the Harness:
notebook.bind(harness);
// On host shutdown:
await notebook.close();
```

`env`, `registry` and `harness` are host-owned Durable objects. Binding the Harness preserves selected-tool metadata and nested call receipts. `maxHeapMiB` defaults to 4096 and must be at least 128. Half the budget belongs to the live kernel. The remainder is divided among isolated workers. `profile` optionally initialises an empty session from a saved TS profile.

## Cells and state

For example, two consecutive `exec` cells can run:

```ts
let count = 0;
const next = () => ++count;
class Counter { value = 10; }
const counter = new Counter();
```

```ts
text([next(), counter.value]);
```

Top-level await works. Bare values produce no output. Use `text`, `image`, `generatedImage` and `notify` for observations. `store(key, value)` and `load(key)` retain named values. `ALL_TOOLS` lists selected registrations, callable through `tools` with their original names and schema-checked inputs. Results remain dynamically typed. Help-backed registrations accept an empty call. Ask before adding npm imports, then use exact-version `npm:` specifiers. Node built-ins, installed packages and local TypeScript modules are supported.

Normal cells run sequentially. A leading `// @exec: {"isolated":true}` forks the last committed portable state, not the current live heap. At most four cells run across the TS session. A completed isolated cell saves a `candidate-*` snapshot without changing live bindings. External tool and file effects are shared.

Use `wait` with the returned cell handle to collect or terminate yielded execution. Await every nested tool and import call. Ending a cell with unsettled calls fails it, cancels its owned calls and invalidates the live kernel.

## Checkpoints and recovery

Call `notebook` with `{}` for help or `{"input":"{\"action\":\"status\"}"}` for state. Lifecycle changes require idle cells. Inside `exec`, `tools.notebook({})` returns help. Status without a query, list and diagnostics are also available there.

Successful live cells save portable state automatically. Plain values, supported built-ins, imports and named function recipes can restore by value without replaying cell history. Arbitrary closures, classes and live handles can remain usable in the running kernel but may be reported as unsaved. Do not assume they survive restart.

- `save` and `load` manage named portable profiles. Loading a profile adds bindings and rejects collisions.
- `pin` promotes portable bindings to shared project state and protects them from `release` and `prune`. `unpin` removes that protection.
- `pin` with `checkpoint: {snapshot: "snapshotName", restore: "restoreName"}` registers named portable helpers for one live binding. The snapshot helper stores data. The restore helper reconstructs the value after restart. Restoration executes those helpers, never the original cells.
- `pin` with `hook: "startup"` awaits a function after fresh-kernel restoration. Startup hooks cannot call tools. `hook: "tool_result"` observes settled nested calls. Calls made by a hook do not recursively trigger hooks. `hook: false` removes a hook.
- `checkpoint` saves current portable state. `restart` rebuilds from the last durable checkpoint. `reset` returns to project pins, preserving saved profiles.

Loading a `candidate-*` snapshot **replaces** the live kernel. It discards live-only values and changes made since that candidate. Release and prune also rebuild the kernel, potentially discarding live-only values. Profile names use 1 to 100 letters, numbers, underscores or hyphens. The `candidate-` prefix is reserved.

Stopping a live cell invalidates its kernel. Use `restart` before further live execution. Interrupted tools and files may already have changed. Effects are neither rolled back nor replayed. Project-pin conflicts preserve the existing project state and save a recovery candidate with an explicit notice.

Each storage namespace and conversation has private session state. Project pins are shared by project path, and named profiles are shared within the configured state directory. Keep this directory private and trusted. Portable snapshots use Node's binary serialisation and are separate from Deno Notebook profiles.
