# Functionality parity

The target is the accepted tool functionality in `howaboua-pi-stuff` at `b2006db9`. The original Durable reference is `earendil-works/pi` at `f5d20047b`, published as `@earendil-works/pi-durable` 1.0.2. The source tree now pins Durable, pi-ai and Chord 1.2.0. Earlier version references below record port-time evidence, not the current dependency requirement. Reference checkout paths are development evidence, not runtime requirements.

Tool arguments, outputs, errors, cancellation, state, and recovery are part of parity. Pi-specific TUI rendering and slash commands are not being shipped as a compatibility layer. Missing functionality must stay visible here until implemented and validated.

The approved 2026-10-09 refresh adopts selected behavior from `69f50cf70e8a7b05c2349be6227f521b6504f80e`, without claiming whole-tree parity at that revision. Component evidence records retry-budget and phase fixes, safe provider errors, foreground screenshots, empty-call discovery, opt-in fresh-note idle rollover, and board continuity. Original extraction pins and historical validation remain identified separately.

| Component | Accepted scope | Evidence |
|---|---|---|
| Patch | TypeScript implementation of `apply_patch` | [Native-helper differential and actual tool use](parity/apply-patch.md) |
| Image viewing | `view_image`, including description for non-multimodal models | [Codec differential and Durable image delivery](parity/view-image.md) |
| Skills | Discovery and reading | [Source comparison and actual skill reading](parity/skills.md) |
| Web | Search and navigation | [Real authenticated search and returned-reference navigation](parity/web-imagegen.md) |
| Image generation | Generation, editing, recent images, artifacts | [Real generation, viewing and recent-image editing](parity/web-imagegen.md) |
| Browser | Logged-in browser control | [CDP lifecycle and output contracts](parity/browser.md) |
| Agents | Durable-native delegation and shared discussion board | [Real Harness delegation, board, recovery and watches](parity/agents.md) |
| Pulses | Clawa Markdown definitions and scheduling with native conversation execution and passive parent results | [Pinned Clawa source and accepted native differences](../packages/pulses/README.md#source-parity) |
| Code | Code execution with included `exec_command` and `write_stdin` | [Actual V8 execution and tool dispatch](parity/code.md) |
| Notebook | Persistent notebook execution with included `exec_command` and `write_stdin` | [Actual Deno execution and by-value recovery](parity/notebook.md) |
| Context | Shared same-storage notes and history reads, own-note writes, explicit checkpoint rollover and opt-in fresh-note idle rollover | [SQLite recovery and real execution-mode rollover](parity/context.md) |
| OpenAI Responses | OpenAI and Codex subscription provider, cached transport, explicit Worker runtime, Lite and replay | [Protocol extraction and runtime evidence](parity/openai-responses.md) |
| Worker Code | Separate bounded Worker execution, not native Code or Notebook parity | [QuickJS WASM and ordinary Durable tool dispatch](parity/worker-code.md) |
| Git and UI SDK | Git read capability and a component-independent interactive UI contract, with the diff renderer as one consumer | [Source extraction and independent host evidence](parity/git-ui.md) |
| Headless presentations | Package-owned summary/detail contracts across the tool components | [Real receipts, lazy detail and host integration](parity/presentations.md) |
| Sites | Structured ChatGPT Sites tools, committed-source saves and explicit deployments | [Offline Harness, Git, binding and recovery evidence](parity/sites.md) |
| Guardian | Explicit tool rules and one-shot review of genuine pending Codex actions | [Provider completion and nested-admission evidence](parity/guardian.md) |
| Grok and GipPity Voice | Separate native voice, dictation, browser control and authorized transfer integrations | [Pinned sources, native artifacts and offline lifecycle evidence](parity/voice.md) |
| Settings | Native component-owned defaults, global and project overrides with explicit storage | [Settings contract and persistence guarantees](../packages/settings/README.md) |

Semantic grep, Ask, isolated review, and side questions are excluded.

## Shared integration

Components register ordinary Durable tools. Code and Notebook must discover the same registrations automatically, including third-party tools. They must preserve validation, hooks, results, cancellation, and ownership without component-specific bridges.

OpenAI Responses is the provider exception. It registers with the host's pi-ai Models collection and consumes the same ordinary tool declarations. It does not register a tool extension.

Code and Notebook ship separately. Their shell implementation is shared internally, not offered as a standalone shell product. Durable task persistence does not imply restoration of external processes or an arbitrary JavaScript heap.

[Shared execution](parity/execution.md) records task ownership, projection and recovery. [Shell](parity/shell.md) records native process behavior and platform limits. `test/toolkit.test.ts` checks native-only context rollover and retained state while switching Code and Notebook in an existing conversation. The default suite keeps consequential boundary contracts, not feature tours. Optional differential probes require the pinned reference binaries and are not part of the ordinary gate.

## Accepted native differences

- Agent delegation and board membership use Durable conversations. Herdr machine and pane control, SSH routing and Ask answers are excluded. Context reads use conversation targets, not attachment permissions or an Agents transcript pager.
- Images use native Durable image content. The provider owns transport detail selection. Original bytes and optional descriptions remain available.
- Host configuration replaces ambient Pi directories, extension globals and terminal rendering. Code and Notebook consume ordinary registrations, not per-tool bridges.
- Context management and OpenAI Responses follow the later source revisions pinned in their parity documents. Context uses one notes-and-history policy, without source backend or continuity-mode selectors.

Linux runtime validation and live service checks do not establish Windows or macOS parity. The component documents distinguish exercised behavior, carried source behavior and unresolved external-platform boundaries.

## Delivery validation

On 2026-10-13, the Durable 1.2.0 migration passed `bun run check`: all 28 retained workflows, twenty-one package builds and dry-pack checks, lint, strict TypeScript and Knip. Frozen installation with lifecycle scripts disabled passed. An independent source review examined native nested admission, ownership, replay and result migration. Disposable Harness checks verified native child cancellation, abandonment flags and Guardian ancestry. A SQLite reopen check preserved version-one cell and invocation output, images, details and checkpoints without replaying completed work. No permanent tests were added. Live providers and non-Linux runtimes were not revalidated.

The 1.2.0 migration uses the published Durable, pi-ai and Chord packages. Tool implementations return `output`, while transcript messages retain `content`. Nested dispatch honours `Agent.callable` and structured output schemas. `new_context` is model-only. Guardian carries native nested-call provenance back to the original model-issued slot, including through pass rules. Grok excludes model-only tools from its nested tool inventory.

Code and Notebook retain their owned cell scheduler because yielded execution, output and image observations, and ordered tool controls are not interchangeable with upstream Code Mode. Tools receive the new retained-output and native nested-call APIs without component-specific bridges. No upstream source is patched. Storage failures now close the Durable session, so hosts must reopen deliberately rather than retrying uncertain side effects. These components supply no custom Storage implementation.

On 2026-10-11, scoped component settings and the pending Pulses and Agents host controls passed one independent review and `bun run check`: all 28 retained workflows, twenty package builds, lint, strict TypeScript, Knip and dry-pack checks. Review found and removed a conversation-wide fallback in Pulses stop. A disposable real Durable probe confirmed that stopping a completed pulse leaves later external input running. Earlier disposable probes covered native receipt replay, conversation reuse, host-message deduplication and owned cancellation.

Settings validation used real Node files and eight competing processes for revision conflicts, bounded persistence and cancellation. Disposable core checks covered invalid values, inheritance removal and persisted-but-failed application. Both voice contributors passed offline controls and persistence probes. No permanent tests were added. Active audio devices and live providers were not exercised. The npm registry still reported Durable 1.1.0 as latest, matching all dependency pins.

On 2026-10-10, the native-boundary cleanup passed independent review and the final `bun run check`: all 28 retained workflows, lint, strict TypeScript, Knip, eighteen builds and dry-pack checks. Disposable Harness and SQLite probes verified shared reads, caller-only note writes, native completion through rollover, watch deduplication, cut recovery, cancellation and queued-input safety. No permanent tests were added. An earlier gate timed out in the unchanged Code output workflow; the unchanged full rerun passed. MCP peers remain necessary through pi-ai's transitive Google declarations.

On 2026-10-09, both voice integrations and the PR #491 provider refresh passed independent review after fixing failed-arrival channel cleanup and final-model pricing attribution. The final `bun run check` passed all 28 retained workflows, lint, strict TypeScript, Knip, eighteen builds and dry-pack checks, including native asset integrity. No permanent tests were added. An earlier run timed out in the unchanged Code output workflow. Its focused rerun and the subsequent complete gate passed without changing code or the timeout. Isolated voice consumer checks passed against the pinned dependency graph, with the current unconstrained npm registry failure documented in [voice evidence](parity/voice.md).

On 2026-10-09, Sites and Guardian passed independent review with no material findings. After correcting declaration placement and unused internal exports, `bun run check` passed all 28 retained workflows, lint, strict TypeScript, Knip, sixteen builds and dry-pack checks. Disposable offline probes covered Sites Git and recovery boundaries, provider completion evidence and genuine nested Guardian admission. No permanent tests were added and no live Sites or Guardian service claims are made.

On 2026-10-09, the selected upstream refresh passed one independent review with no material findings and `bun run check`: all 28 retained workflows, lint, strict TypeScript, Knip, fourteen builds and dry-pack checks. No permanent tests were added. Live screenshot focus, provider accounts and non-Linux runtimes were not revalidated.

On 2026-10-08, the contract-spine cull reduced the default suite from 48 to 28 tests and removed 3,011 test and fixture lines. Production code was unchanged. `bun run check` passed all retained tests, including real V8, Deno and workerd execution, strict TypeScript, lint, Knip and all twelve builds and dry-pack checks. Component evidence below distinguishes earlier validation from checks still run by the gate.

The 1.1.0 upgrade forwards the Harness's Models collection to nested tool calls, matching the new `ToolExecutionApi.models` contract. Nested hooks already receive the public task runtime, including `models`. Upgrade-time V8 validation verified the same Models instance reached execution and both hooks, failing before the forwarding fix and passing afterward. That regression fixture is not retained. The OpenAI Responses provider already uses pi-ai's timed `AssistantMessageEventStream`; upgrade-time SQLite validation checked that assistant and tool durations survived into the conversation context. That upstream timing fixture is not retained. No custom Storage implementation or positional `TaskRuntime.context()` cutoff needs migration here. Scan order defaults remain unchanged. Hosts supplying custom storage must implement 1.1.0's ordered scans.

On 2026-10-08, `bun run check` passed against 1.1.0: all 48 workflows, native V8, Deno and workerd execution, strict TypeScript, lint, Knip and all twelve builds and dry-pack checks. Frozen installation with lifecycle scripts disabled also passed. Existing release archives were not rebuilt or republished.

The 1.0.4 upgrade tracks the published Durable, pi-ai and Chord packages, not upstream's unreleased branch. Nested tool calls now expose the tail output window, account for environment-omitted output, and honor `settings.progress.outputIntervalMs`. The carried output buffer includes 1.0.4's tail-snapshot and byte-order-mark fixes. Components continue to consume the host's execution environment; they do not implement a parallel filesystem adapter. Original source and license notices remain pinned to their extraction versions unless code was refreshed.

On 2026-10-07, the full delivery gate passed against 1.0.4, including native V8, Deno and workerd workflows and all twelve package builds and dry-pack checks. Upgrade-time nested-output validation checked configured windows, skipped-byte accounting and preserved U+FEFF text. Its tail-snapshot regression failed with the old snapshot compaction and passed with the refreshed buffer. Those upstream regression fixtures are not retained. Frozen installation with lifecycle scripts disabled also passed.

The delivery gate is `bun run check`: formatting, strict TypeScript 7, Knip, actual tool workflows, all public package builds and dry-pack checks. The ten native tool-component tarballs previously passed isolated consumer installation, strict public-declaration checking and the Code-to-Notebook toolkit workflow, including native context rollover, using only package exports. Provider delivery additionally checks the bundled public entry and its consumer declarations. Worker Code adds real workerd execution and exact pinned WASM asset checks.

Live checks exercised authenticated web search and reference navigation, image generation and recent-image editing, unchanged image bytes, and Chrome CDP evaluation and screenshot capture. Live SSH deployment and non-Linux runtimes remain unverified.
