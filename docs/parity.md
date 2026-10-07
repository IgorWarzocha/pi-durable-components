# Functionality parity

The target is the accepted tool functionality in `howaboua-pi-stuff` at `b2006db9`. The original Durable reference is `earendil-works/pi` at `f5d20047b`, published as `@earendil-works/pi-durable` 1.0.2. The source tree now pins Durable, pi-ai and Chord 1.0.4. Earlier version references below record port-time evidence, not the current dependency requirement. Reference checkout paths are development evidence, not runtime requirements.

Tool arguments, outputs, errors, cancellation, state, and recovery are part of parity. Pi-specific TUI rendering and slash commands are not being shipped as a compatibility layer. Missing functionality must stay visible here until implemented and validated.

| Component | Accepted scope | Evidence |
|---|---|---|
| Patch | TypeScript implementation of `apply_patch` | [Native-helper differential and actual tool use](parity/apply-patch.md) |
| Image viewing | `view_image`, including description for non-multimodal models | [Codec differential and Durable image delivery](parity/view-image.md) |
| Skills | Discovery and reading | [Source comparison and actual skill reading](parity/skills.md) |
| Web | Search and navigation | [Real authenticated search and returned-reference navigation](parity/web-imagegen.md) |
| Image generation | Generation, editing, recent images, artifacts | [Real generation, viewing and recent-image editing](parity/web-imagegen.md) |
| Browser | Logged-in browser control | [CDP lifecycle and output contracts](parity/browser.md) |
| Agents | Durable-native delegation and shared discussion board | [Real Harness delegation, board, recovery and watches](parity/agents.md) |
| Code | Code execution with included `exec_command` and `write_stdin` | [Actual V8 execution and tool dispatch](parity/code.md) |
| Notebook | Persistent notebook execution with included `exec_command` and `write_stdin` | [Actual Deno execution and by-value recovery](parity/notebook.md) |
| Context | Local notes, retained history, checkpoint rollover and managed idle admission | [SQLite recovery and real execution-mode rollover](parity/context.md) |
| OpenAI Responses | OpenAI and Codex subscription provider, cached transport, explicit Worker runtime, Lite and replay | [Protocol extraction and runtime evidence](parity/openai-responses.md) |
| Worker Code | Separate bounded Worker execution, not native Code or Notebook parity | [QuickJS WASM and ordinary Durable tool dispatch](parity/worker-code.md) |

Semantic grep, Ask, isolated review, and side questions are excluded.

## Shared integration

Components register ordinary Durable tools. Code and Notebook must discover the same registrations automatically, including third-party tools. They must preserve validation, hooks, results, cancellation, and ownership without component-specific bridges.

OpenAI Responses is the provider exception. It registers with the host's pi-ai Models collection and consumes the same ordinary tool declarations. It does not register a tool extension.

Code and Notebook ship separately. Their shell implementation is shared internally, not offered as a standalone shell product. Durable task persistence does not imply restoration of external processes or an arbitrary JavaScript heap.

[Shared execution](parity/execution.md) records task ownership, projection and recovery. [Shell](parity/shell.md) records native process behavior and platform limits. `test/toolkit.test.ts` exercises the public toolkit under both modes, then switches the selected mode in an existing conversation. The default suite favors real tool workflows over private-helper tests. Optional differential probes require the pinned reference binaries and are not part of the ordinary gate.

## Accepted native differences

- Agent delegation and board membership use Durable conversations. Herdr machine and pane control, SSH routing, shared-context attachment and Ask answers are excluded.
- Images use native Durable image content. The provider owns transport detail selection. Original bytes and optional descriptions remain available.
- Host configuration replaces ambient Pi directories, extension globals and terminal rendering. Code and Notebook consume ordinary registrations, not per-tool bridges.
- Context management and OpenAI Responses follow the later source revisions pinned in their parity documents. Context uses one notes-and-history policy, without source backend or continuity-mode selectors.

Linux runtime validation and live service checks do not establish Windows or macOS parity. The component documents distinguish exercised behavior, carried source behavior and unresolved external-platform boundaries.

## Delivery validation

The 1.0.4 upgrade tracks the published Durable, pi-ai and Chord packages, not upstream's unreleased branch. Nested tool calls now expose the tail output window, account for environment-omitted output, and honor `settings.progress.outputIntervalMs`. The carried output buffer includes 1.0.4's tail-snapshot and byte-order-mark fixes. Components continue to consume the host's execution environment; they do not implement a parallel filesystem adapter. Original source and license notices remain pinned to their extraction versions unless code was refreshed.

On 2026-10-07, the full delivery gate passed against 1.0.4, including native V8, Deno and workerd workflows and all twelve package builds and dry-pack checks. The nested-output workflow checks configured windows, skipped-byte accounting and preserved U+FEFF text. Its tail-snapshot regression fails with the old snapshot compaction and passes with the refreshed buffer. Frozen installation with lifecycle scripts disabled also passed.

The delivery gate is `bun run check`: formatting, strict TypeScript 7, Knip, actual tool workflows, all public package builds and dry-pack checks. The ten native tool-component tarballs previously passed isolated consumer installation, strict public-declaration checking and the Code-to-Notebook toolkit workflow, including native context rollover, using only package exports. Provider delivery additionally checks the bundled public entry and its consumer declarations. Worker Code adds real workerd execution and exact pinned WASM asset checks.

Live checks exercised authenticated web search and reference navigation, image generation and recent-image editing, unchanged image bytes, and Chrome CDP evaluation and screenshot capture. Live SSH deployment and non-Linux runtimes remain unverified.
