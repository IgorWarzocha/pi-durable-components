# Code Mode for Durable

Run JavaScript that composes ordinary Durable tools. `exec` and `wait` are the model-facing surface. Shell execution and PTY sessions are included.

Requires Node 22.19 or newer and Durable 1.1.0.

```sh
npm install https://github.com/IgorWarzocha/pi-durable-components/releases/download/v0.5.0/howaboua-pi-durable-code-0.5.0.tgz
```

The shell's native PTY addon requires Python, Make and a C++ compiler on Linux. If install scripts are disabled, run `npm rebuild node-pty` before using interactive shells. Pipe-based commands do not require the addon.

Create the component before opening your harness, install its extension, and select that extension in the conversation.

```ts
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { createCodeMode, createNodeShellBackend } from "@howaboua/pi-durable-code";

let harness: Harness;
const code = createCodeMode({
  shell: { backend: createNodeShellBackend({ environmentId: "local" }) },
  cancelTask: (id, context) => harness.abortTask(id, context),
});
const registry = createRegistry();
registry.install(code.extension);
// Install your other extensions in the same registry.
harness = await Harness.open(storage, { models, registry, env }, context);
code.bind(harness);
const conversation = await harness.root(context, {
  agent: { model, extensions: [code.extension, otherExtension] },
});
```

`storage`, `models`, `model`, `env`, and `context` are your normal Durable setup. The shell backend's `environmentId` must equal your execution environment's `id`. A sandbox or remote environment needs a backend for that environment. No operation silently uses local shell execution instead.

An agent can now use JavaScript such as `text(await tools.some_tool({ ... }))`. Installed tools need no Code-specific adapter. `ALL_TOOLS` contains their original names, usage, descriptions, and input schemas. Names with punctuation remain callable through `tools[name]`.

Registrations with `executionHints.nativeOnly: true` remain native model tools and cannot be called inside cells. Binding the Harness enables this projection using the conversation's selected tools. Context management uses it for `new_context`.

Tool results expose meaningful `details` together with their result content. Empty details fall back to parsed JSON text or unchanged text. Images add a base64 `image_url` suitable for `image(result)` and `generatedImage(result)`. Tool failures throw in JavaScript. Durable still owns validation, wrappers, hooks, usage accounting, cancellation, and unsafe-operation recovery.

## Custom commands

Existing custom-tool TOML definitions are supported. Supply the directories and their trust decisions explicitly. The package never scans Pi's home directory or enables bundled examples.

The same custom-command factories are available from the separate Notebook package. Both packages use one internal implementation and register ordinary Durable tools.

```ts
import { createCustomCommands, createNodeCommandBackend } from "@howaboua/pi-durable-code";

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
// Select commands.extension alongside code.extension in the conversation.
```

Later trusted directories override earlier ones. Invalid overrides remain disabled instead of falling back to a different global command. Untrusted directories are not read.

Each top-level `.toml` filename names a tool. Required fields are `usage` and `command`. Optional fields are `description`, `output`, `args`, `input`, `defer_loading`, and `yield_time_ms`. Every command accepts one string and returns one string. Relative command paths resolve from the TOML directory. Absolute JavaScript files run through the backend's JavaScript launcher. Bare commands resolve through that backend's `PATH`. Commands run directly without shell expansion, in the conversation's working directory.

`input` is `"arg"` by default or `"stdin"`. Successful output is stdout with trailing whitespace removed, then stderr when stdout is empty, then `(no output)`. Nonzero exits include stderr. Combined output is capped at 50 KiB. Cancellation drains the owned process group where supported.

Definitions are reread before execution. The live loader refreshes ordinary registry registrations before model requests, so additions, removals, and metadata changes appear in `ALL_TOOLS`. `defer_loading = false` promotes only the current usage line into the Code prompt. `yield_time_ms` overrides the initial exec wait when source directly calls that tool. Multiple direct calls use the largest configured value.

`loadCustomCommandTools(options, context)` provides a snapshot loader instead when the host wants to publish registry updates itself. `commands.errors` exposes discovery errors. Call `await commands.close()` when removing the live loader.

## Runtime boundaries

The component automatically downloads the standalone OpenAI Codex V8 host pinned to `rust-v0.145.0`. Downloads are checksum verified. Supported platforms are Linux, macOS, and Windows on x64 and ARM64. `hostPath` selects an explicitly provisioned compatible host. `cacheDirectory` changes the download cache. Unix automatic installation needs `tar`.

Each cell has a fresh isolated V8 context with text, image, notification, timer, yield, and exit helpers. It has no filesystem, network, Node globals, or arbitrary imports. Use ordinary tools for those capabilities. `store(key, value)` and `load(key)` retain serializable data within one conversation's live host session. Lexical bindings do not survive between Code cells. Use the separate Notebook package when you need persistent bindings and imports.

Yielded cells remain owned by the conversation. `wait` observes the existing cell. Its output budget applies to that delivery, not the cell's accumulated lifetime. One bounded observation is retained until delivered, then native output collection continues. Termination cancels owned nested calls and interrupts V8. Interrupted work is reported rather than replayed after a process restart. Native host state and PTYs do not survive that restart.

Call `await code.close()` when disposing the component, then close your harness. This stops native hosts and shell sessions.

If the native host exits unexpectedly, interrupted output remains observable. Recreate the component before running new cells. The package does not silently replace a lost session with an empty one.

## Headless presentations

Available in local-development builds, not release 0.5.0.

`@howaboua/pi-durable-code/presentation` exports `codeCapability`, `codeSummary` and `codeDetail`. These browser-safe descriptors are structurally compatible with the UI SDK without importing it. They perform no I/O and have no renderer.

The host supplies `{cell, result}`. Each field is explicitly nullable. A cell is `{id, status}`, with a canonical positive decimal task ID and the actual coordinator status: `running`, `completed`, `failed`, `aborted` or `interrupted`. Read these from exec/wait receipt details `cellId` and `status`. Do not substitute host request activity for cell lifecycle.

`result: null` means output has not been acquired. Otherwise pass the ordinary execution receipt. Parsing retains text, base64 images, `isError`, JSON details and structured diagnostics. Omitted fields normalize to empty content, false, null and empty diagnostics. Usage and controls remain Durable-owned, not presentation actions. Summary selects title, cell identity and status, output availability and nullable `isError`. Detail selects the full validated state. Summary can request detail without acquiring it.

The host authorizes `exec` and `wait` through ordinary registrations and publishes acquired receipts on the declared `results` stream. This is host publication, not a new runtime stream or tool bridge. Each receipt is one bounded observation, not cumulative output. Presentation disposal does not terminate cells, roll back effects or authorize replay. Acquisition, binding and cancellation policy belong to the host.
