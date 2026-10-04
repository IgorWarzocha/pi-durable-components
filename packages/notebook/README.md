# Notebook for Durable

Run TypeScript in a persistent Deno kernel. Globals and imports survive between cells. Serializable values and self-contained functions restore from checkpoints without replaying the cells that created them. Shell tools are included.

Requires Node 22.19 or newer and Durable 1.0.2.

```sh
npm install https://github.com/IgorWarzocha/pi-durable-components/releases/download/v0.2.0/howaboua-pi-durable-notebook-0.2.0.tgz
```

The shell's native PTY addon requires Python, Make and a C++ compiler on Linux. If install scripts are disabled, run `npm rebuild node-pty` before using interactive shells. Pipe-based commands do not require the addon.

Install the extension before opening your harness. Bind native execution explicitly to the same filesystem namespace as the conversation.

```ts
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { createNotebookMode, createNodeShellBackend } from '@howaboua/pi-durable-notebook';

const env = new NodeExecutionEnv({ cwd: process.cwd() });
let harness: Harness;
const notebook = createNotebookMode({
  stateDirectory: '/absolute/path/to/notebook-state',
  native: { environmentId: env.id },
  shell: { backend: createNodeShellBackend({ environmentId: env.id }) },
  cancelTask: (id, context) => harness.abortTask(id, context),
});
const registry = createRegistry();
registry.install(notebook.extension);
// Install the other tools you want the notebook to call.
harness = await Harness.open(storage, { models, registry, env: () => env }, context);
notebook.bind(harness);
```

`storage`, `models`, and `context` are your normal Durable setup. Select the Notebook extension and the other extensions you want in the conversation. Select only one of Code and Notebook at a time.

The agent uses `exec` with TypeScript source. Plain source is accepted by the tool's freeform preparation. JSON tool callers use `{ "code": "text(await tools.some_tool({ ... }))" }`. `ALL_TOOLS` contains the selected tool contracts. Every ordinary Durable registration is callable without a Notebook adapter. Durable owns validation, wrappers, hooks, task ownership, usage accounting, and interruption handling.

Ordinary registration `executionHints` can supply custom usage, output help, a discovery schema, promotion, and a direct-call yield budget. Tools remain deferred by default. Promoted tools add one usage line to the prompt. Direct-call yield hints take precedence over the cell's pragma. Tool names remain unchanged and punctuation is callable through `tools[name]`.

Registrations with `executionHints.nativeOnly: true` stay native model tools and are unavailable inside cells, including through retained tool functions. Binding the Harness enables their native projection. Context management uses this boundary for `new_context`.

Tool results preserve their details and content. Images expose a base64 `image_url` usable with `image(result)`. Tool failures throw inside the cell. Bare expression values are discarded, so use `text(value)` to emit output.

Call `notebook` with `{ "input": "help" }` for state management. It covers checkpoints, protected project bindings, profiles, disposal, recovery, and historical diagnostics. New npm imports require approval and exact-version `npm:` specifiers. Successfully used imports are inventoried per project. This approval guidance is not a package sandbox.

## Custom commands

Existing custom-tool TOML definitions are supported through ordinary Durable registrations. Supply their directories and trust decisions explicitly; the package does not scan Pi's home directory or enable bundled examples.

```ts
import { createCustomCommands, createNodeCommandBackend } from '@howaboua/pi-durable-notebook';

const commands = await createCustomCommands({
  registry,
  files: env,
  backend: createNodeCommandBackend({ environmentId: env.id }),
  roots: [
    { path: globalCommands, trusted: true },
    { path: projectCommands, trusted: projectIsTrusted },
  ],
  onDiscoveryError: error => console.error(error.message),
}, context);
// Select commands.extension alongside notebook.extension in the conversation.
```

Each top-level `.toml` filename names a tool. Required fields are `usage` and `command`; optional fields are `description`, `output`, `args`, `input`, `defer_loading`, and `yield_time_ms`. Later trusted directories override earlier ones. Invalid overrides remain disabled rather than falling back to a global command. Untrusted directories are not read.

Commands accept one string, passed as a final argument by default or through stdin with `input = "stdin"`. They run without shell expansion in the conversation's working directory. Relative command paths resolve from the TOML directory; bare commands use the backend's `PATH`; absolute JavaScript files use its JavaScript launcher. Filesystem and process backends must share the conversation's environment namespace.

Successful output is stdout with trailing whitespace removed, then stderr when stdout is empty, then `(no output)`. Nonzero exits include stderr. Combined output is capped at 50 KiB. Cancellation drains the owned process group where supported.

Definitions are reread before execution. The live loader refreshes ordinary registry registrations before model requests, exposing additions, removals and metadata changes in `ALL_TOOLS`. `defer_loading = false` promotes the usage line into the Notebook prompt. Direct-call `yield_time_ms` hints take precedence over the exec pragma; multiple direct calls use the largest hint. No Notebook-specific command bridge is required.

`loadCustomCommandTools(options, context)` provides a snapshot loader for hosts that publish registry updates themselves. `commands.errors` exposes discovery errors. Call `await commands.close()` when removing the live loader.

## Runtime and persistence

Deno 2.9.7 downloads only when execution or diagnostics first needs it. Archives and extracted binaries are verified against pinned sizes and SHA-256 checksums. Linux, macOS, and Windows support x64 and ARM64. `stateDirectory` owns the executable cache, private session checkpoints, project generations, conflict journals, named profiles, and standard `.ipynb` journals. `maxHeapMiB` defaults to 4096. `profile` optionally loads a named profile at kernel startup.

Each conversation has a private kernel. Project bindings merge under cross-process locks. Other live kernels are not mutated. Checkpoints restore by value, not by replay. Imported modules, promises, weak collections, and live resource handles must be recreated after restart. Function restoration requires self-contained definitions. Durable pins protect bindings from release and pruning. Startup and tool-result hooks are deliberately awaited, and hook calls do not recursively trigger hooks.

This is native Deno, with filesystem, network, process, and codec capabilities. It is not a JavaScript-only substitute or a security sandbox. `native.environmentId` must match the execution environment. Remote and container environments must explicitly provision the harness and Deno in the same native namespace. A mismatch fails rather than falling back to host files. `native.env` selects the kernel process environment when supplied.

Only one exec cell can be active per conversation. `wait` observes that cell without replaying it. Termination cancels owned nested work and invalidates the active kernel. External side effects are not rolled back. After a host restart, interrupted work is reported instead of being executed again. Live kernels and PTYs do not survive a host restart.

Call `await notebook.close()` before closing your harness. It joins active cells and closes kernels, bridge servers, and owned shell sessions.
