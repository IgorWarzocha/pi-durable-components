# OpenAI Responses provider parity

The reference is `packages/pi-codex-conversion/src/providers` in `IgorWarzocha/howaboua-pi-stuff` at `5dc8fa4bbded063f9c158e2af7a8a53eeaea7fbb`. The checkout was read-only. Its uncommitted context-management changes did not affect the extracted provider files. The package preserves the source MIT notices and credits the Pi-derived protocol code.

This is a pi-ai 1.0.2 Provider consumed by Durable's Models collection. It is not a Pi ExtensionAPI compatibility layer. It does not replace the separate standard OpenAI API provider.

## Carried behavior

| Boundary | Preserved behavior |
|---|---|
| Requests | Codex endpoint resolution, account-bearing bearer auth, request and session headers, 64-character prompt-cache keys, encrypted reasoning, effort clamping, service tier, verbosity and no unsupported output-token cap. Positional system messages and changing tool declarations use pi-ai's transcript contracts. |
| Replay | Model-switch normalization, stable type-correct call IDs, paired results, interrupted-call repair, recorded custom-tool input, namespaces, native image/web items and encrypted outputs. Tool-pair normalization remains the final request boundary after payload hooks. |
| Grammar | Strict JSON schema policy, OpenAI Lark and regex tools, streamed grammar arguments and recorded input-property provenance. Current declarations do not reactivate removed historical tools. |
| Responses Lite | Supported-model gate, tools and instructions moved into the input, functions namespace, all-turn reasoning context, parallel calls disabled, transport-specific Lite metadata, remote-image omission and bounded inline-image preparation. |
| Streaming | SSE parsing, native Responses event processing, encrypted reasoning and final text signatures, function/custom calls, refusal/error handling and rejection of unfinished or ambiguous calls. Provider events reach the observer before normalization. |
| WebSockets | Header-bearing connections, route-scoped cached leases, concurrent uncached leases, exact request/history validation for previous-response deltas, physical socket-loss recovery and speculative handshake overlap with final preparation. |
| Recovery | Bounded streamed-request retries, SSE request retries, server-directed delay deadlines, three-minute recovery budgets, terminal quota/capacity errors, immediate upgrade/oversize fallback and session-sticky SSE. Authentication fallback stays request-local. |
| Prewarm | Non-generating ordinary warmup, live-socket readiness checks and explicit generated keepalive on an isolated lane. The main continuation baseline does not advance for isolated keepalive. |
| Canonical history | Completed final request plus raw output, guarded against stale completions and validated by model/account/endpoint/history. Ordinary reconnects send reconstructed transcript items. Validated canonical snapshots are exposed only for host-owned checkpoint preparation. |
| Usage | Separate uncached input, cache reads, cache writes and output. Existing cost tiers and default/flex/priority/fast adjustments. No invented cache hit or account-billing reconciliation. |
| Auth and catalog | Browser PKCE, callback/manual completion, headless device-code flow, cancellation, refresh and Codex catalog supplements. `gpt-reserve` remains resolvable but hidden from availability. |

## Durable adaptation and intentional fixes

- Every provider instance owns its transport state. Closing or resetting a session cancels active requests and prewarms, closes cached and uncached sockets, aborts pending handshakes and joins owned Node dispatchers. Reset rejects new work until the lane is drained. Nothing claims these resources survive a restart.
- Node uses Undici's supported header-capable WebSocket client. A supported per-connection Dispatcher interceptor preserves failed-upgrade HTTP status, which Undici otherwise omits from its WebSocket error event. No dependency is patched. SSE honors pi-ai's injected `fetch`. `maxRetryDelayMs` honors the current public contract alongside the source recovery budget.
- OAuth JSON is validated and malformed credential responses are not dumped into errors. Unused manual login prompts receive cancellation. Live token refresh and interactive login were not exercised in this extraction.
- Sharp replaces the Pi image helper and Photon. Decoder acceptance and resized bytes can differ. Existing images that fit the source bounds retain their original bytes. Oversized images retain the 2048-pixel limit and are reduced until the actual 32-pixel patch count is at most 2500. Cancellation reaches native decoding and encoding.
- Responses Lite selection depends on ordinary grammar tool declarations and the model capability gate, not a Pi execution-mode setting. Hosts can explicitly enable or disable it. No Code-specific or Notebook-specific provider bridge was added.
- Review reproduced three inherited source defects. Cached tool-result deltas previously accepted matching call IDs despite rewritten earlier history. That shortcut is removed. Historical `fc_` function calls previously inherited a newly enabled grammar declaration. Recorded function provenance now wins. Output and usage observer exceptions previously retried completed generation. Those exceptions are now terminal and visible.

## Validation

The protocol extraction passed 115 source differential outcomes before the three intentional corrections. Cases covered strict schemas, declaration conversion, transcript/model switching, native image/web items, reasoning request shape, pairing, configuration updates, non-image Lite transforms and output streaming. Native image probes exercised dimensions, patch limits and cancellation.

Four maintained workflows use a real local HTTP/WebSocket server, actual pi-ai Models and, for the native tool round, Durable with official SQLite storage. They protect tool execution and usage, both directions of function/grammar mode switching, exact-prefix deltas, changed-prefix full replay, canonical snapshot rejection, prewarm, session and instance isolation, sticky fallback, cancellation, reset and close. Observer regressions require one backend request and one callback effect before a visible failure on both transports. These fixtures establish project-owned protocol decisions, not external OpenAI compatibility.

`scripts/smoke-provider.mjs` passed against a real Codex account on 2026-10-04. It used the extracted provider through Durable, executed a real native calculation over SSE, executed real Code Mode JavaScript over Responses Lite WebSockets, and completed an ordinary follow-up on each lane. Credentials were supplied explicitly, remained unchanged and were not refreshed.

The live Code lane sent 5 input items initially. The next request sent 1 instead of 7, and the follow-up sent 1 instead of 9, both with validated continuation on the reused socket. All six live requests completed without retry or fallback. Backend usage reported zero cache reads and writes for these short prompts. This proves continuation reuse, not a prompt-cache hit, latency improvement or billing reduction.

The release gate passed all 35 workflows, strict TypeScript 7, formatting, Knip, eleven builds and eleven package checks. The actual provider archive was installed into a fresh external npm consumer with scripts disabled. Its public declarations passed strict checking without `skipLibCheck`, and all four provider workflows passed again using only the installed package export.

## Explicit exclusions

Pi menus, status widgets, usage dashboards, reserve auto-switching, settings persistence and extension events are not included. Neither are the generic configured-provider proxy overlay, remote context/namespace routers, idle keepalive scheduling, automatic reasoning-selector history, encrypted checkpoint persistence or a native compaction policy. Pure configuration-update normalization and compatible native input support remain available, but the host owns generating and persisting those items. Existing Durable context management remains separate.

WebSocket proxy selection follows explicit request environment overrides and process proxy settings. Custom SSE routing uses the public `fetch` option. Non-Linux platforms, custom Codex passthroughs, interactive authentication and long-prompt cache economics remain unverified. The source's carried retry policy can regenerate incomplete model output, but no tool executes before Durable receives a completed, validated call.
