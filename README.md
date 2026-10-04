# Pi Durable Components

Tools and execution runtimes for `@earendil-works/pi-durable`, ported from [Howaboua Pi Stuff](https://github.com/IgorWarzocha/howaboua-pi-stuff). Components use ordinary Durable registrations. Code and Notebook automatically discover selected tools, including third-party registrations.

| Package | Use |
|---|---|
| [apply-patch](packages/apply-patch) | Codex-style file patches, implemented in TypeScript |
| [view-image](packages/view-image) | Original image bytes and optional vision-model descriptions |
| [skills](packages/skills) | Skill discovery and progressive reading |
| [web](packages/web) | Codex web search and navigation |
| [imagegen](packages/imagegen) | Image generation, editing and workspace artifacts |
| [browser](packages/browser) | Authenticated Chrome control through CDP |
| [agents](packages/agents) | Durable worker conversations, delegation and watches |
| [code](packages/code) | Isolated V8 execution with ordinary tools and shell sessions |
| [notebook](packages/notebook) | Persistent Deno TypeScript, checkpoints, profiles and shell sessions |

Public package names start with `@howaboua/pi-durable-`. Code and Notebook are separate products. Install either or both, but select only one execution mode per conversation at a time. Both include `exec_command` and `write_stdin`. There is no standalone shell package.

## Build and use

Requires Node 22.19 or newer, Bun 1.4.2, and Durable, pi-ai and Chord 1.0.2. This repository builds local package artifacts. It does not install extensions into your existing Pi setup.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run setup:native
bun run check
```

`bunfig.toml` uses Bun's isolated linker and global cache. The native setup command uses node-pty's supported installer. Building the addon may require Python and a C++ compiler. Run the Durable host in Node. The local PTY backend refuses Bun because node-pty currently loses output there.

Each package README shows its factory and required host capabilities. Install the resulting extension in your Durable registry and select it for the conversation. For example:

```ts
import { createRegistry } from "@earendil-works/pi-durable";
import { ApplyPatch } from "@howaboua/pi-durable-apply-patch";
import { skills } from "@howaboua/pi-durable-skills";

const registry = createRegistry();
const skillTools = skills({ sessionRoot: ".agent/skills" });
registry.install(ApplyPatch);
registry.install(skillTools);
// Pass registry to Harness.open(). Select these extensions on your agent.
```

After building, run `npm pack` from a package directory to create an installable tarball. Use the package's `dist` entry points, not a `source` export condition.

## Host boundaries

File tools use the conversation's execution environment. Native shell and Notebook capabilities require an explicit matching environment identity. Browser connections, state directories, authentication and provider routing are host-supplied. Nothing imports Pi's extension API or silently substitutes local files for a remote environment.

Code provisions a checksum-pinned V8 host. Notebook provisions checksum-pinned Deno on first use. Notebook has native filesystem, network and process access. It is not a security sandbox. Image viewing uses native codecs behind a TypeScript tool implementation.

Persisted tasks do not make processes immortal. Interrupted side effects are reported, not replayed. Live Code state, kernels and PTYs do not survive host restart. Notebook checkpoints restore supported values without replaying cells.

Agents use Durable conversations rather than terminal panes or SSH routing. Semantic grep, Ask, isolated review and side-question tools are not included. [Parity evidence and remaining platform boundaries](docs/parity.md) describe the port precisely.

## Validation

`bun run check` runs Biome formatting checks, strict TypeScript 7, Knip, real-tool workflows, builds and package-content checks. The toolkit workflow uses the actual V8 and Deno runtimes to invoke patches, image viewing, skills, shell/PTY sessions and worker delegation through Durable. A scripted model selects calls without replacing the tools themselves.

External-service validation is separate from the default gate. With an existing, unexpired native pi-ai credential file:

```sh
node scripts/smoke-live.mjs --credentials /path/to/auth.json
node scripts/smoke-live.mjs --credentials /path/to/auth.json --images
```

The first command searches and opens a returned web reference. `--images` adds two real image-service requests: generation, byte-preserving viewing, and recent-image editing. These requests can incur charges. The script does not modify credentials and removes its temporary artifacts.
