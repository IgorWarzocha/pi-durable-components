# Pi Durable Components

File tools, web search, image generation, browser control, worker agents with a shared board, context management and an optimised Codex provider for [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable).

Install only the components you need. Use their tools directly, or call them together from JavaScript with Code Mode or persistent TypeScript with Notebook Mode.

## Install

Requires a Node.js host running Pi Durable 1.0.2. Tool extensions are imported by your application and installed with Durable's `registry.install(...)`. The OpenAI Responses provider registers with your host's pi-ai Models collection. Neither uses `pi install`.

[Prebuilt packages](https://github.com/IgorWarzocha/pi-durable-components/releases) can be installed with npm. They are not published to the npm registry. For example, install Apply Patch:

```sh
npm install https://github.com/IgorWarzocha/pi-durable-components/releases/download/v0.3.0/howaboua-pi-durable-apply-patch-0.3.0.tgz
```

Then add it to the registry passed to your Harness:

```ts
import { createRegistry } from "@earendil-works/pi-durable";
import { ApplyPatch } from "@howaboua/pi-durable-apply-patch";

const registry = createRegistry();
registry.install(ApplyPatch);
```

If your application already has a registry, use that one. Conversations use installed extensions by default. If you select extensions explicitly, include `ApplyPatch` in that selection. Remove it with `registry.uninstall(ApplyPatch)`.

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
| [Agents](packages/agents) | Delegate work and share findings on a persistent discussion board |
| [Context](packages/context) | Save notes, retrieve history and resume through clean context windows |
| [OpenAI Responses](packages/openai-responses) | Use our optimised Codex provider with cached WebSockets and Responses Lite |
| [Code Mode](packages/code) | Run JavaScript that calls tools, with a fresh context for each cell |
| [Notebook Mode](packages/notebook) | Run persistent TypeScript with imports, checkpoints and profiles |

Code and Notebook both include shell tools. Select one execution mode per conversation. Both discover the conversation's ordinary tools, including tools from other Durable extensions.

## Before you run

- Node.js 22.19 or newer is required. Linux is the tested platform.
- File tools use the conversation's execution environment. Shell and Notebook need native access to that environment. Shell requires Node, not Bun.
- Code and Notebook install a native PTY addon. Linux installation requires Python, Make and a C++ compiler. If install scripts are disabled, run `npm rebuild node-pty` before using interactive shells.
- Code downloads a checksum-verified V8 host on first use. `store` and `load` retain values between cells.
- Notebook downloads checksum-verified Deno on first use. It has filesystem, network and process access. It is not a sandbox.
- Web and Image Generation require Codex-compatible credentials supplied by your host. Browser requires Chrome with remote debugging enabled.
- A host restart ends live kernels and shell sessions. Interrupted work is reported rather than replayed. Notebook can restore checkpointed values without rerunning cells.
- Context management uses the host's SQLite database. Route user input through its managed submission API for durable idle checkpointing.

Ported from [Howaboua Pi Stuff](https://github.com/IgorWarzocha/howaboua-pi-stuff). [Parity notes](docs/parity.md) record the supported behavior and remaining platform limits.
