# Pi Durable Components

File tools, web search, image generation, browser control, worker delegation, shared discussion boards, context management and an optimised Codex provider for [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable).

Install only the components you need. Use their tools directly, or call them together from JavaScript with Code Mode or persistent TypeScript with Notebook Mode.

## Install

The source tree requires Pi Durable 1.4.0. Most components require a Node.js host. Worker Code and the OpenAI Responses provider also support Cloudflare Workers. Tool extensions are imported by your application and installed with Durable's `registry.install(...)`. The OpenAI Responses provider registers with your host's pi-ai Models collection. Neither uses `pi install`.

Durable 1.4 automatically migrates SQLite storage to schema version 2. Older Durable versions cannot reopen it. Upgrade the host and its components together, and plan recovery before opening an existing database. Older versions also cannot resume the new sleeping tasks in JSONL storage.

[Prebuilt packages](https://github.com/IgorWarzocha/pi-durable-components/releases) can be installed with npm. They are not published to the npm registry. Release 0.9.1 includes all 25 components and targets Durable 1.4.0, with matching pi-ai and Chord versions. For example, install Apply Patch:

```sh
npm install https://github.com/IgorWarzocha/pi-durable-components/releases/download/v0.9.1/howaboua-pi-durable-apply-patch-0.9.1.tgz
```

Then add it to the registry passed to your Harness:

```ts
import { createRegistry } from "@earendil-works/pi-durable";
import { ApplyPatch } from "@howaboua/pi-durable-apply-patch";

const registry = createRegistry();
registry.install(ApplyPatch);
```

If your application already has a registry, use that one. Conversations use installed extensions by default. If you select extensions explicitly, include `ApplyPatch` in that selection. Remove it with `registry.uninstall(ApplyPatch)`.

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
