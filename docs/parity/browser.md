# Browser parity

Pinned source: `howaboua-pi-stuff/packages/pi-browser` at `b2006db9def12c373ae48e70044d30f7d6b7e34f`. The checkout was read only. `packages/browser/NOTICE` retains the MIT notices for pasky and Igor Warzocha and records provenance.

## Native integration

`packages/browser/src/index.ts` exports an ordinary Durable `ToolRegistration` and `createBrowserExtension`. The host explicitly supplies native private state and an artifact store and owns `close()`. The tool uses Durable conversation IDs as ownership IDs, Chord cancellation, running output/details and strict JSON results. It is replay-unsafe. There is no Pi `ExtensionAPI`, `ExtensionContext`, TUI, slash command or component-specific Code/Notebook bridge.

Pi's `/browser` settings UI, ambient Pi configuration path, extension startup/shutdown wiring and legacy bridge metadata are not emulated. Typed route configuration, explicit persistence and the lifecycle factory replace those host integration surfaces. The agent-facing command grammar and operations remain.

## Route persistence correction

The whole-package audit against read-only Pi Stuff `12c4357b2c401fe9be8c6c82d2ae252c0f986937` found that source `config.ts:111-161` owns reusable normalised atomic persistence as well as Pi settings wiring. The native package now exports `BrowserRouteConfigStore`, `createBrowserRouteConfigFileStore`, `readBrowserRouteConfig` and `writeBrowserRouteConfig`. Hosts select an absolute native file path or supply atomic complete-value storage. There is no implicit home-directory access.

Missing configuration means local-only routing. Invalid JSON or invalid routes fail visibly. Writes normalise hosts, aliases and the remote Node path, use a unique private temporary file and atomic rename, and remove configuration when no remote hosts remain. Concurrent replacements retain source last-writer-wins semantics without an extra lock protocol. Hosts still own settings UI and runtime replacement.

A disposable real-filesystem probe verified twelve concurrent complete replacements, consistent aliases, mode 0600, temporary-file cleanup, visible corruption and deletion back to the local-only default. It did not contact CDP or SSH. No permanent tests were added.

## Upstream refresh

The 2026-10-09 refresh follows source revision `69f50cf70e8a7b05c2349be6227f521b6504f80e`, including foreground screenshot capture from `1feee203`. Screenshots disable background focus emulation and activate their target inside the existing serialized tab turn. This changes browser focus. Other operations retain their previous rendering policy.

Empty calls return help. Known response-length hints are ignored by operations that do not consume them, while page reads retain validation. Disposable real-Harness probes exercised discovery, unknown-field rejection and request normalization. The retained registration workflow and package typecheck passed. No Chrome binary was available for this refresh, so foreground capture itself remains unverified live. Earlier screenshot evidence below predates the focus change.

## Contract evidence

| Contract | Source and carried implementation | Evidence |
| --- | --- | --- |
| `command`, raw strings and object preparation | Source `browser-tool.ts`; native `src/index.ts` retains `prepareBrowserInput` semantics, including unknown envelope fields for schema rejection | Durable schema is `{command?:string}` with no additional properties. Empty calls return help. Tool results retain serialized text plus details. |
| Single action, fixed-order batches, validation, help | `browser/request.ts`, `operation.ts`, `operation-input.ts`, `parse-operation.ts`, `parse-tab-operation.ts`, `help.ts` | Parsers and operation definitions carried directly. Help drops Pi/bridge instructions, not actions. Parser unit fixtures were pruned. |
| `start`, `tabs`, `open`, `show`, `close`, `find`, `stop` | `browser/operation-executor.ts`, `launcher.ts`, all `cdp` discovery/session/tabs/pages/snapshot modules | Complete source implementations retained. Tabs and snapshots retain pagination, ownership flags, compact element references and filtering. Canned CDP unit fixtures were pruned. |
| `click`, `type`, `fill`, `press`, `wait`, `navigate`, `load_all` | `cdp/actions/{click,type,fill,key,wait,page,element}.ts` | Complete action bodies retained. No skeletal dispatch branches. Canned click fixtures were pruned. |
| `evaluate`, `html`, `network`, `raw` | `cdp/evaluate.ts`, `cdp/actions/page.ts`, operation executor | Source CDP methods and text conversion retained, with artifact-store injection instead of host-global writes. Raw CDP still accepts arbitrary method/params. Actual Harness calls evaluated a safe blank tab through both live and isolated Chrome CDP. |
| `screenshot` viewport, ID and selector | `cdp/actions/screenshot.ts`, `element.ts`, operation executor | Source CDP capture/geometry/DPR retained. Capture writes bytes through an explicit target. Actual Harness capture from isolated Chromium produced a valid 780x493 PNG in the invocation's environment. Shared-browser capture reported its real CDP timeout rather than a synthetic success. |
| Output bounds and `read_result`/`discard_result` | `browser/bounds.ts`, `artifacts.ts` | Existing 32,000-byte escaped-text chunks, 1-hour result TTL, 24-hour screenshot TTL, complete-read removal and pagination retained. `test/registration.test.ts` executes a two-result batch through the real Harness and protects every model-visible cursor against framework re-truncation. |
| Local CDP discovery and Linux launch | `cdp/discovery.ts`, `browser/launcher.ts` | Original host/port, port-file candidates and systemd launch behavior retained. Host can explicitly replace discovery/launch callbacks. Discovery now observes connection cancellation and bounds HTTP responses to 1 MiB. |
| SSH routing and deployed helper | `browser/{config,routes,remote,remote-helper,remote-process,worker-server,worker-client,worker-socket}.ts`, `src/remote-worker.ts` | All source transport/deployment/daemon bodies carried, not replaced with CDP forwarding. SSH aliases, configured Node path, source-hash worker identity, marker-owned atomic deployment, private socket checks, same-host continuations, SCP screenshots and remote deletion retained. Bundle must ship as `dist/remote-worker.js`. |
| Reuse, ownership, cancellation and shutdown | `BrowserRuntime`, `BrowserCdpSession`, `BrowserTabs`, `CdpClient`, process and worker owners | Per-conversation root/tab connections, serialized tab work, 20-minute idle retirement, persisted ownership, opener inheritance and restart scoping retained. Direct-runtime fixtures were pruned. |

## Explicit filesystem boundary

Browser transport remains an explicitly authorized native Node capability. Native browser port-file reads, tab-ownership metadata and temporary SCP staging belong to the configured native host. They do not follow arbitrary `api.env` routes. This distinction is documented rather than hidden behind a portable filesystem claim.

Model-visible local screenshots and continuation files use `api.env` when present. Otherwise the host's configured `BrowserArtifactStore` is required. `environmentArtifactStore` never falls back to Node filesystem IO. Remote continuations remain in the explicitly selected worker's native store. Remote screenshots are staged privately, published to the invocation's store and cleaned up locally. This replaces upstream XDG/tmp host-global artifact writes while preserving output and continuation semantics.

Lifecycle corrections required by the native host boundary are explicit: runtime close joins active calls and bridge detachment, worker shutdown destroys active sockets and aborts its runtime, helper deployment observes caller cancellation rather than leaving a detached deployment waiter, and overflowing child output is rejected after the killed process exits. No interrupted browser mutation is replayed.

The Durable worker deliberately owns a separate deployment/state namespace. It installs at `~/.cache/pi-durable-browser/worker.mjs` with marker `// @howaboua/pi-durable-browser managed worker`. Remote sockets and artifacts use `XDG_RUNTIME_DIR/pi-durable-browser`, or a user-scoped `pi-durable-browser-UID` temporary directory. Windows pipes use `pi-durable-browser-worker-ID`. The Pi worker at `~/.pi/agent/pi-browser-worker.mjs` and Pi's `browser-tool` state are not adopted, rewritten or permission-adjusted. Existing Pi continuation handles are not imported. This isolation preserves the browser operations without modifying installed Pi tooling.

The registration overrides Durable's default output truncation with `Number.MAX_SAFE_INTEGER` byte and line limits. Browser-owned per-operation bounds still apply. This preserves the source's combined batch result rather than cutting serialized JSON between operations. The Harness regression reproduced invalid JSON at the default 50 KiB boundary before the override. With the override, both independently bounded results and their continuation handles reach model-visible content intact. Generic Code/Notebook dispatch also reads ordinary registration `outputLimits`, with no browser-specific adapter.

## Validation and limits

Focused strict TS7 check and declaration emit passed with `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` and erasable syntax. The retained `packages/browser/test/registration.test.ts` exercises the actual Harness batch-output boundary. Parser, canned CDP and direct-runtime helper fixtures were deleted rather than archived.

The accepted Bun build produced a standalone 140.1 KB `dist/remote-worker.js` containing its Durable managed-file marker. A controlled local smoke launched that bundle's daemon in a temporary runtime directory, sent a valid protocol request through a second bundle process, confirmed invalid worker actions fail, then sent SIGTERM and verified clean daemon exit and owned-socket removal. Pre-existing Pi `browser-tool` state and directory permissions remained unchanged. No CDP browser or remote SSH machine was involved. Root wired the same bundle step and Durable marker into `scripts/workspaces.mjs`.

Real toolkit validation used this package's `createBrowserExtension` through the installed Durable Harness, not the old Pi browser tool. Against the existing local Chrome 152 CDP endpoint, `help` and `tabs` succeeded, returning 23 tabs without truncation. `evaluate` on an existing `about:blank` tab returned `{"readyState":"complete","protocol":"about:","dpr":1}`. The sanitized result is `/tmp/pi-durable-browser-live-tdMbEw/result.json`. A read-only screenshot request on that shared blank tab failed with the preserved error `Chrome did not answer Page.captureScreenshot after two 15s attempts. The tab may be unresponsive or suspended.` No tab was activated or navigated to force capture.

An explicitly permitted private headless Chromium fixture then validated real `help`, `tabs`, `evaluate` and `screenshot` calls through the same production registration and Harness. Capture returned a 2,138-byte PNG, 780x493 pixels, DPR 1, at `/tmp/pi-durable-browser-headless-vjJR3L/.pi/browser/browser-8E4EBFAF-5d98dfe5-7b22-44c1-996d-eef840ea6234.png`. Its PNG signature and dimensions were read from the actual file. The result is `/tmp/pi-durable-browser-headless-vjJR3L/result.json`. This confirms the screenshot belongs to the supplied execution environment rather than the native fallback store. Runtime and Harness were closed, the private Chromium process group was stopped and its disposable profile was removed. No permanent test was added.

Real SSH/SCP deployment was not exercised. The retained package Harness workflow reads real cached artifacts but does not by itself claim external browser compatibility. Root owns the repository umbrella gate. Root resolved the external declaration dependency previously reported during installation. No operational credentials, user browser settings or remote machines were changed.

## 2026-10-19 source alignment

Inspected read-only Pi Stuff snapshot `7f3295e67a8e6146b2a6922b56a06fa4db5c3a32` against `036dc876da5afc4ec27b64878ebb1cfb30c8211d`.

The only new browser execution delta is source experimental GPT-mode help wording and its Pi prompt-mode registration. The ordinary help already preserves host affinity, returned references, independent batches and consequential-action safety. Those behaviours remain the native contract; alternate Pi prose switching is excluded. The ordinary browser registration now explicitly declares help-backed discovery. No component-specific Code or Notebook bridge was added.

A disposable real Harness exercised empty Browser, Sites and Sites documentation calls without CDP discovery, OAuth, project access or network traffic. Safety and resource guidance survived the native output boundary. The generic execution contract reader rendered all three as help-backed capability entries. No permanent tests were added.

## 2026-10-26 PR #552 result alignment

Compared read-only source `a06eae4d..1338b66a1067c254fec46746ef96b6bd9456148b`. Browser now declares its JSON program result through Durable's ordinary `structuredOutputSchema` and `structuredOutput`. The generic nested dispatcher therefore returns the browser object without adding display `content`. Native text and details remain available. Help now describes `{action,...fields}` rather than requiring stringification or parsing at nested call sites. No Browser-specific Code or Notebook bridge was added.

A disposable Node 26 probe exercised the production registration through Durable Harness and the generic value projection. Empty input returned the help object directly, with no extra `content`. The retained real-Harness batch continuation check passed. No CDP connection or browser mutation was needed for these result-boundary changes.
