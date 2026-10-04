# Pi Durable Components

File tools, web access, browser control and agent delegation for [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable), ported from [Howaboua Pi Stuff](https://github.com/IgorWarzocha/howaboua-pi-stuff).

Use the tools directly, or call them from JavaScript with Code Mode or TypeScript with Notebook Mode. Both modes expose the tools selected for the conversation through `tools`, including tools from other Durable extensions.

These are libraries for a Durable host, not extensions for the Pi coding-agent CLI.

| Package | What it does |
|---|---|
| [apply-patch](packages/apply-patch) | Add, edit, move and delete files with Codex-format patches |
| [view-image](packages/view-image) | View local images or describe them for text-only models |
| [skills](packages/skills) | Find skills and read their instructions and references |
| [web](packages/web) | Search the web and follow result references through Codex |
| [imagegen](packages/imagegen) | Generate and edit images, saving results in the workspace |
| [browser](packages/browser) | Control Chrome through CDP using its existing login session |
| [agents](packages/agents) | Delegate to worker conversations and receive their results |
| [code](packages/code) | Run isolated JavaScript that calls tools |
| [notebook](packages/notebook) | Run persistent TypeScript with imports, checkpoints and profiles |

Package names use the prefix `@howaboua/pi-durable-`. Code and Notebook each include `exec_command` and `write_stdin`. Select only one execution mode per conversation at a time.

## Build and install

The packages are not published to npm yet. Build them from this repository.

Requires Node 22.19 or newer and Bun 1.4.2. The packages target Durable, pi-ai and Chord 1.0.2.

```sh
git clone https://github.com/IgorWarzocha/pi-durable-components.git
cd pi-durable-components
bun install --frozen-lockfile --ignore-scripts
bun run setup:native
bun run build
```

Bun uses its global cache. `setup:native` builds node-pty when a prebuilt addon is unavailable, which requires Python and a C++ compiler. Run your Durable host in Node. Bun-hosted PTYs are currently unsupported.

Pack the component you need, for example:

```sh
npm pack --workspace @howaboua/pi-durable-code
```

Install the resulting `.tgz` in your Durable host project with `npm install /path/to/package.tgz`. Each package README shows how to create its tools, register its extension and select it for a conversation.

## Runtime requirements

- File tools use the conversation's execution environment. Shell and Notebook require native access to that same environment.
- Code downloads a checksum-verified V8 host on first use. Each cell gets a fresh JavaScript context. `store` and `load` retain values between cells.
- Notebook downloads checksum-verified Deno on first use. Bindings persist between cells, and supported values can be restored from checkpoints. Deno has filesystem, network and process access. It is not a sandbox.
- Web and image generation need a Codex-compatible account or backend. Browser control needs Chrome with remote debugging enabled.
- Live Code state, kernels and shell sessions cannot be resumed after a host restart. Interrupted work is reported rather than replayed. Notebook restores checkpointed values without rerunning cells.

Linux is the tested runtime platform. Windows, macOS and browser deployment over SSH remain unverified. See [parity notes](docs/parity.md) for source comparisons and known differences.

## Development checks

```sh
bun run check
```

Runs formatting, strict TypeScript 7, Knip, tool workflows, builds and package checks. The workflows use the real V8 and Deno runtimes, files, shell sessions and Durable worker conversations. Model responses are scripted to choose calls, not to fabricate tool results.

Live service checks are separate. They require an unexpired Codex credential in pi-ai's `auth.json` format. Adding `--images` makes two image-service requests and can incur charges.

```sh
node scripts/smoke-live.mjs --credentials /path/to/auth.json
node scripts/smoke-live.mjs --credentials /path/to/auth.json --images
```

The script searches, opens a returned web reference and, with `--images`, generates, views and edits an image. It leaves credentials unchanged and removes its temporary files.
