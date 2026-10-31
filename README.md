# Pi Durable Components

File tools, web search, image generation, browser control, worker delegation, shared discussion boards, context management and an optimised Codex provider for [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable).

Install only the components you need. Use their tools directly, or call them together from JavaScript with Code Mode or persistent TypeScript with Notebook Mode.

## How this fits into your app

Pi Durable is a TypeScript library for running agents, with persisted conversations, tasks and tool execution. Your application hosts that runtime and supplies its models, credentials, storage and user interface. These components add tools and services to it. Howcode is one consuming app. None of these packages requires Howcode.

Any compatible Durable host can use the packages through their public APIs. Installing an npm dependency makes its code available to your app. Your app must still register it, provide its required capabilities and choose which conversations can use it. There is no automatic plugin discovery or shared marketplace loader in these packages today.

For app authors building a component catalogue, the [marketplace proposal](docs/marketplace.md) describes the shared portable boundary and the remaining activation work. It does not require Howcode's adapter format.

## Install

Release 0.9.1 publishes all 25 components individually to npm and targets Pi Durable, pi-ai and Chord 1.4.0. Most components require Node.js 22.19 or newer. Worker Code and the OpenAI Responses provider also support Cloudflare Workers with the configuration in their guides. A browser-only app needs a backend for native components.

Durable 1.4 automatically migrates SQLite storage to schema version 2. Older Durable versions cannot reopen it. Upgrade the host and its components together, and plan recovery before opening an existing database. Older versions also cannot resume the new sleeping tasks in JSONL storage.

For example, install Apply Patch with its matching runtime peers:

```sh
npm install @howaboua/pi-durable-apply-patch@0.9.1 @earendil-works/pi-durable@1.4.0 @earendil-works/pi-ai@1.4.0 @earendil-works/chord@1.4.0
```

All 25 components are also available as [GitHub release archives](https://github.com/IgorWarzocha/pi-durable-components/releases/tag/v0.9.1). Their package guides include archive install commands. Neither installation method uses `pi install`.

## Connect a Durable host

For a plain tool extension such as Apply Patch, install it in the registry passed to your Harness. This example uses your app's configured Models collection, selected model, storage and request context. The workspace must already be authorised by your app. `NodeExecutionEnv` grants local filesystem and process access; its working directory is not a sandbox.

```ts
import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai/models";
import {
  createRegistry, Harness, type ModelRef, type Storage,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { ApplyPatch } from "@howaboua/pi-durable-apply-patch";

export async function openAgent(options: {
  models: Models;
  model: ModelRef;
  storage: Storage;
  workspace: string;
  context: Context;
}) {
  const { models, model, storage, workspace, context } = options;
  const registry = createRegistry();
  registry.install(ApplyPatch);
  const environment = new NodeExecutionEnv({ cwd: workspace });
  const harness = await Harness.open(storage, {
    models, registry, env: () => environment,
  }, context);
  const conversation = await harness.root(context, {
    agent: { model, extensions: [ApplyPatch] },
  });
  return { harness, conversation, environment };
}
```

Submit input and observe results through your normal Durable APIs. At shutdown, close the Harness and then call `environment.cleanup(context)`. The app owns the storage lifetime.

If your app already has a Harness, add the extension to its existing registry rather than opening a second runtime. Conversations use registered extensions by default. An app with user-controlled enablement should persist an explicit extension selection for each conversation, including an empty selection when everything is disabled. Registering a package must not silently enable it for every user.

### What your host needs to provide

- **One shared runtime.** Resolve compatible Durable, pi-ai and Chord peers to the host's instances. Do not bundle private copies of those runtimes into a component.
- **Registration and selection.** Plain extensions use `registry.install(extension)`. Select them through the conversation's `agent.extensions`. Code and Notebook discover ordinary selected tools automatically, without component-specific bridges.
- **Capabilities and credentials.** Supply the conversation's execution environment and any additional native process, browser, network, audio or settings capabilities required by the component. Models owns provider access. A missing capability must remain unavailable rather than falling back to the host machine.
- **Lifecycle.** Some packages export factories rather than a ready-made extension. Create them with their documented options, install the returned extension, bind them to the Harness where required, and close them through their documented lifecycle. Preserve live work when changing a selection. Removing a registry entry is not resource cleanup.
- **The right integration kind.** The OpenAI Responses package registers a provider with `models.setProvider(...)`, not the tool registry. UI SDK and Settings expose host-facing contracts. Do not guess a factory from an export name or treat every package root as an extension.

Components run as trusted application code. Package installation, imports and native helpers can execute code. Catalogue entries and permission descriptions are not a sandbox. The host must enforce its grants and trust policy before loading or activating a component.

Component-specific setup is documented in the guides below. A host can support plain extensions without implementing every optional service, UI or native capability. Unsupported components should stay visibly unavailable. Disabling or uninstalling a component must stop its owned work without replaying interrupted side effects or silently deleting feature data.

Upgrading Agents from 0.5.0 requires installing standalone Board and updating saved extension selections before resume. See the [Board migration guide](packages/board/README.md#migrating-from-bundled-board).

## Choose your tools

Each component's guide includes its install command and host configuration.

| Component | Use it to |
|---|---|
| [Apply Patch](packages/apply-patch) | Add, edit, move and delete files with Codex-format patches |
| [View Image](packages/view-image) | View local images or describe them for text-only models |
| [Skills](packages/skills) | Find skills and read their instructions and references |
| [Web](packages/web) | Search the web and follow returned references through Codex |
| [Image Generation](packages/imagegen) | Generate and edit images, saving results in the workspace |
| [Browser](packages/browser) | Control Chrome through CDP using its existing login session |
| [Agents](packages/agents) | Delegate work to persistent workers and receive their results |
| [Board](packages/board) | Share persistent discussions between Durable conversations, independently of Agents |
| [Pulses](packages/pulses) | Run scheduled Markdown prompts in owned conversations and deliver passive results |
| [Context](packages/context) | Save notes, retrieve history and resume through clean context windows |
| [OpenAI Responses](packages/openai-responses) | Use cached OpenAI or Codex WebSockets on Node and Workers, with Responses Lite in Codex mode |
| [Code Mode](packages/code) | Run JavaScript that calls tools, with a fresh context for each cell |
| [Notebook Mode](packages/notebook) | Run persistent TypeScript with imports, checkpoints and profiles |
| [TS Notebook](packages/ts-notebook) | Run strictly checked TypeScript with persistent closures and class instances |
| [JS Notebook](packages/js-notebook) | Run persistent JavaScript with complete QuickJS VM checkpoints |
| [Worker Code](packages/worker-code) | Run bounded JavaScript and ordinary tools inside Cloudflare Workers |
| [Git](packages/git) | Read repository diffs, full-text context and images through an explicit execution capability |
| [UI SDK](packages/ui) | Build interactive component UIs with live state, actions and streams through one host contract |
| [Sites](packages/sites) | Save committed source and manage ChatGPT Sites with explicit deployment visibility |
| [Guardian](packages/guardian) | Enforce explicit tool rules and request one-shot Codex action review |
| [Grok Voice](packages/grok-voice) | Use xAI realtime voice, dictation and browser audio controls |
| [GipPity Voice](packages/gippity-voice) | Use Codex subscription voice, dictation and browser audio controls |
| [Settings](packages/settings) | Persist component-owned global and project preferences with revision checks |
| [Dictation](packages/dictation) | Transcribe recorded audio locally with Whisper through an explicit native model capability |
| [Nested AGENTS.md](packages/nested-agents-md) | Load scoped guidance as file operations reach nested directories |

The UI SDK works with component-defined state and interactions, without importing React or the Durable runtime. Hosts supply authorised capabilities and transport. See the [interactive Git review host](examples/component-ui). The optional React diff renderer is one consumer, not the SDK's integration boundary.

The tool packages also expose [headless summary and detail contracts](docs/presentations.md). Build native controls around the same bound state without importing a component's execution runtime into the browser. Hosts decide when to acquire detail and where to display it.

Code and all three Notebook packages include shell tools. Select one execution mode per conversation. Each discovers the conversation's ordinary tools, including tools from other Durable extensions.

Worker Code is a separate, bounded execution mode. It uses QuickJS WASM without shell, native imports or ambient network access. It is not a replacement for native Code or Notebook.

## Before you run

- Native components require Node.js 22.19 or newer. Linux is the tested native platform.
- File tools use the conversation's execution environment. Shell and Notebook need native access to that environment. Shell requires Node, not Bun.
- Code and Notebook install a native PTY addon. Linux installation requires Python, Make and a C++ compiler. If install scripts are disabled, run `npm rebuild node-pty` before using interactive shells.
- Code downloads a checksum-verified V8 host on first use. `store` and `load` retain values between cells.
- Notebook downloads checksum-verified Deno on first use. It has filesystem, network and process access. It is not a sandbox.
- Web and Image Generation require Codex-compatible credentials supplied by your host. Browser requires Chrome with remote debugging enabled.
- Voice needs explicit audio permissions and one application-owned microphone lease shared by both integrations. LAN control requires host-supplied TLS and network permission. Native helpers ship for six platform targets, but device and live-provider acceptance remain separate checks.
- A host restart ends live kernels and shell sessions. Interrupted work is reported rather than replayed. Notebook can restore checkpointed values without rerunning cells.
- Context management uses the host's SQLite database. Automatic idle rollover is off by default. Opt in through the host and use managed submission to roll over only when fresh checkpoint notes already exist.

## Local delivery

Run `bun run check` to validate and build all packages, then `bun run pack` to write content-hashed archives under `dist/`. `dist/artifacts.json` records each package name, version, archive filename and full SHA-256. Consume the indexed filenames rather than selecting older archives by version alone.

Ported from [Howaboua Pi Stuff](https://github.com/IgorWarzocha/howaboua-pi-stuff). [Parity notes](docs/parity.md) record the supported behavior and remaining platform limits.
