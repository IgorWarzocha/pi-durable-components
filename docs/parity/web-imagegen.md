# Web and image generation parity

The accepted reference is `IgorWarzocha/howaboua-pi-stuff` at `b2006db9def12c373ae48e70044d30f7d6b7e34f`. The reference packages are `packages/pi-codex-web-run` and `packages/pi-codex-imagegen`. Their OpenAI Codex protocol snapshots are pinned to `b545c94041017d000e2c8b2f6272705d21b85dfb`. Reference checkouts were read-only.

## Source adaptation

`packages/codex/src/http.ts`, `cloudflare-cookies.ts`, `headers.ts` and `urls.ts` carry the proven TypeScript transport from the web reference. Product schemas and request builders were lifted from each reference. Image binary format validation and chronological recent-image selection were also carried across. Imports use local `.ts` paths. Pi integration, TUI rendering, event-bus discovery, session projection and per-tool Code Mode adapters are not shipped.

The internal codex source compiles into each public product. It is not a standalone runtime product. Both products retain the original MIT notice and the Apache 2.0 snapshot license in their NOTICE files.

## Preserved contracts

| Boundary | Implementation and evidence |
| --- | --- |
| Web arguments | The accepted schema keeps search and image queries, recency, domains, open, click, find, response length and settings. Additional properties remain accepted. The request builder forwards all non-settings command keys, including screenshot, finance, weather, sports and time from `search_types.rs`. |
| Web request | POST `/alpha/search` sends stable provider session identity, request model, commands, default direct callers, external access and fixed 2500-token output budget. No conversation input or reasoning is introduced. Caller settings remain authoritative. |
| Web results | Modern output text and search results remain intact, including opaque reusable references. Legacy output/results normalize as in the reference. Results persist as `details.webRun`. Tool output uses the same 8 MiB byte limit as the HTTP envelope, without Durable's default 2000-line cap. Non-success HTTP responses retain diagnostics for Cloudflare challenges, unavailable endpoints and response text. |
| Model and auth selection | Host pi-ai Models supplies current models, preferred Codex fallback models, available models and auth resolution. Explicit Codex provider routing outranks hosted endpoint resolution. Ordinary Responses providers require opt-in. Token and account extraction preserve Codex-specific precedence and JWT account claims. Provider and model headers survive auth resolution. |
| Route configuration | `normalizeCodexToolRouteConfig` validates the host-loaded config with normalized provider and canonical-model keys. Alias lookup and `PI_CODEX_MODEL` behavior are preserved. Endpoints distinguish Codex and ordinary Responses transport. |
| HTTP | Proxy selection runs for every destination. Ten redirects maximum. Cross-origin credentials are removed. ChatGPT requests refuse redirects outside supported ChatGPT hosts. Only allowed Cloudflare cookies are retained. HTTP method rewriting and body-header removal follow the reference. Response limits are 8 MiB for web and 64 MiB for images. Cancellation reaches fetch and owned proxy agents close in finally. |
| Image selectors and request | Omitted selectors generate. Local targets and recent-image count are exclusive. Up to five targets. Validated PNG, JPEG, GIF and WebP local bytes become data URLs. Requests use `/images/generations` or `/images/edits`, `gpt-image-2.5`, auto size and quality, and transparency only when true. These are the reference's reviewed deltas from its older Rust snapshot. |
| Active images | Selection uses `Conversation.context(context).messages`, not raw entries or an append-only session log. Replacement edits, excluded messages and compaction heads are applied before selecting newest images and restoring chronological order. |
| Artifact storage | Every workspace operation uses the invocation's ExecutionEnv. Symlink edit targets resolve through the environment. Root discovery looks for `.git` and otherwise uses cwd. Unique `ig_*.png` artifacts and the first-image latest alias preserve relative and absolute output paths. |
| Image results | Image response metadata and request ID are returned with saved paths. Image-capable conversations receive original output bytes as image attachments. Text-only models receive paths. Provider-reported usage is retained as metadata without fabricating price. |
| Lifecycle | Ordinary ToolRegistrations and defineExtension bundles integrate with Durable. ProviderDoc supplies persistent session affinity. Chord cancellation controls network and filesystem work. Both tools use unsafe replay. Image generation is sequential to avoid latest-alias races within a conversation. |

## Validation

The coordinating agent ran `scripts/smoke-live.mjs` successfully against a real Codex account on 2026-10-04. Authentication used native pi-ai Models, InMemoryCredentialStore and the official openaiCodexProvider. Only conversation model routing was scripted. Every registered tool used its real implementation and network transport. The smoke verified:

- Web search followed by opening a returned reference.
- Image generation with nonempty workspace artifacts and native image delivery.
- `view_image` output byte equality with the generated artifact.
- An image edit using `num_last_images_to_include: 1` from the active conversation context.

The smoke requires an explicit `--credentials` path. `--images` opts into two real image requests. The successful run did not mutate authentication files and removed its temporary artifacts. It establishes ordinary Codex routing, generation and recent-image editing for that account, not every custom backend or image format.

Local HTTP echo fixtures and their tool-call helper were removed in favor of this live workflow and the repository's toolkit integration check. The default gate does not exercise compaction-aware image replacement. The implementation reads Durable's derived active context, but the successful live smoke only verifies recent-image selection without compaction.

A one-time public Harness check after review returned a controlled web response containing 224055 UTF-8 bytes across 4001 lines. The ordinary registered tool preserved the full text and tail reference in model-visible content and structured details. This checks that Durable's default output truncation no longer cuts accepted long responses. No permanent HTTP fixture suite was added.

## Explicit integration differences and limits

- Durable 1.0.2 ToolExecutionApi.conversation returns an invocation-only handle without `context()`. The host must provide the narrow conversation lookup for recent images. Missing capability produces an error, not a fallback to raw history.
- The host owns loading `pi-codex-tools.json` and authentication configuration. Components never read global host config files behind an execution environment's back. pi-ai Models owns OAuth refresh and credential storage. A hosted resolver is passed explicitly instead of discovered through Pi events.
- Durable persists JSON details, so undefined metadata fields are omitted. Its image content type has no Pi rendering `detail` field. Terminal-specific renderers and package changelog UI are replaced by the host's normal Durable presentation.
- Backend model availability, custom endpoint support and Cloudflare clearance remain account-dependent. The successful live smoke does not establish transparency pixel quality. The source's earlier transparency results are not new validation evidence.
- No pricing table is inferred from response token counts. Reported usage remains available in image metadata. Durable billing aggregation needs an application-owned pricing policy if the backend does not supply normalized cost data.
- A crash or cancelled response is not permission to replay a remote image generation. Unsafe replay preserves Durable's interrupted outcome. Successful remote response followed by decode or artifact failure is reported as uncertain local completion, with no automatic repeat.
