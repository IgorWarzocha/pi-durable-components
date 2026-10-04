# Functionality parity

The target is the accepted tool functionality in `howaboua-pi-stuff` at `b2006db9`. The Durable reference is `earendil-works/pi` at `f5d20047b`; published package compatibility starts at `@earendil-works/pi-durable` 1.0.2. Reference checkout paths are development evidence, not runtime requirements.

Tool arguments, outputs, errors, cancellation, state, and recovery are part of parity. Pi-specific TUI rendering and slash commands are not being shipped as a compatibility layer. Missing functionality must stay visible here until implemented and validated.

| Component | Accepted scope | Evidence |
|---|---|---|
| Patch | TypeScript implementation of `apply_patch` | [Native-helper differential and actual tool use](parity/apply-patch.md) |
| Image viewing | `view_image`, including description for non-multimodal models | [Codec differential and Durable image delivery](parity/view-image.md) |
| Skills | Discovery and reading | [Source comparison and actual skill reading](parity/skills.md) |
| Web | Search and navigation | [Real authenticated search and returned-reference navigation](parity/web-imagegen.md) |
| Image generation | Generation, editing, recent images, artifacts | [Real generation, viewing and recent-image editing](parity/web-imagegen.md) |
| Browser | Logged-in browser control | [CDP lifecycle and output contracts](parity/browser.md) |
| Agents | Durable-native delegation and coordination | [Real Harness delegation, recovery and watches](parity/agents.md) |
| Code | Code execution with included `exec_command` and `write_stdin` | [Actual V8 execution and tool dispatch](parity/code.md) |
| Notebook | Persistent notebook execution with included `exec_command` and `write_stdin` | [Actual Deno execution and by-value recovery](parity/notebook.md) |

Semantic grep, Ask, isolated review, and side questions are excluded.

## Shared integration

Components register ordinary Durable tools. Code and Notebook must discover the same registrations automatically, including third-party tools. They must preserve validation, hooks, results, cancellation, and ownership without component-specific bridges.

Code and Notebook ship separately. Their shell implementation is shared internally, not offered as a standalone shell product. Durable task persistence does not imply restoration of external processes or an arbitrary JavaScript heap.

[Shared execution](parity/execution.md) records task ownership, projection and recovery. [Shell](parity/shell.md) records native process behavior and platform limits. `test/toolkit.test.ts` exercises the public toolkit under both modes, then switches the selected mode in an existing conversation. The default suite favors real tool workflows over private-helper tests. Optional differential probes require the pinned reference binaries and are not part of the ordinary gate.

## Accepted native differences

- Agent delegation uses Durable conversations. Herdr machine and pane control, SSH routing, context-board attachment and Ask answers are excluded.
- Images use native Durable image content. The provider owns transport detail selection. Original bytes and optional descriptions remain available.
- Host configuration replaces ambient Pi directories, extension globals and terminal rendering. Code and Notebook consume ordinary registrations, not per-tool bridges.

Linux runtime validation and live service checks do not establish Windows or macOS parity. The component documents distinguish exercised behavior, carried source behavior and unresolved external-platform boundaries.

## Delivery validation

`bun run check` passes formatting, strict TypeScript 7, Knip, actual tool workflows, all nine package builds and dry-pack checks. All nine tarballs were also installed into an isolated consumer using Bun's global cache. After running node-pty's supported native installer, the consumer passed strict public-declaration checking and the same Code-to-Notebook toolkit workflow using only package exports.

Live checks exercised authenticated web search and reference navigation, image generation and recent-image editing, unchanged image bytes, and Chrome CDP evaluation and screenshot capture. Live SSH deployment and non-Linux runtimes remain unverified.
