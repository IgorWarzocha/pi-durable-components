# OpenAI Responses

Our optimised Responses provider for Pi Durable. It carries cached WebSockets, validated continuation, grammar tools and stream recovery without the coding-agent extension. Codex mode also supports Responses Lite.

Codex mode remains the default. Explicit direct mode targets OpenAI's ordinary Responses endpoint and accepts Pi's `openai` direct-subscription OAuth credential. Direct mode uses WebSockets only and never falls back to SSE.

## Install

Requires pi-ai 1.0.2. Node.js 22.19 or newer is supported, with Linux tested. Cloudflare Workers with `nodejs_compat` use an explicit native Upgrade runtime, described below.

```sh
npm install https://github.com/IgorWarzocha/pi-durable-components/releases/download/openai-responses-v0.4.0/howaboua-pi-durable-openai-responses-0.4.0.tgz
```

Register the provider with the same Models collection your Harness uses:

```ts
import { createModels } from "@earendil-works/pi-ai";
import { createOpenAIResponsesProvider } from "@howaboua/pi-durable-openai-responses";

const provider = createOpenAIResponsesProvider();
const models = createModels({ credentials: credentialStore });
models.setProvider(provider);

// Pass models to Harness.open(...).
// Select { provider: "openai-codex", modelId: "gpt-6-luna" }.
```

`credentialStore` is your application's pi-ai CredentialStore containing the `openai-codex` OAuth credential. Models owns refresh and storage. The provider never reads Pi's authentication files. New accounts can use `provider.auth.oauth.login(interaction)` through your host's normal authentication interface. Browser login and headless device-code login are included.

This replaces `openai-codex` in that Models collection. It is not a tool extension and does not use `registry.install` or `pi install`. A custom `id`, `baseUrl` and model catalog are supported for explicitly Codex-compatible routes.

## Direct OpenAI WebSockets

```ts
const provider = createOpenAIResponsesProvider({
  mode: "direct",
  runtime: "workerd", // Omit on Node or Bun.
});
models.setProvider(provider);
```

Direct mode replaces `openai` in the host's Models collection, uses the stock OpenAI catalog and connects to `wss://api.openai.com/v1/responses`. The existing `openai` OAuth credential must include its issued `clientId` for refresh. Refresh is fetch-native. Interactive login delegates to stock pi-ai and belongs on a Node host, not inside a Worker.

Workers use authenticated native `fetch` Upgrade with `response.webSocket.accept()`. Node proxy environment routing does not apply to this runtime. Keep the provider on the conversation's owning Durable Object instance. Socket state is in memory and cannot survive an instance restart.

Cached continuation, grammar tools, native input items, explicit prewarm, usage observers, cancellation, session reset and close use the same implementation in both modes. Direct mode rejects Responses Lite and Codex compaction requests. HTTP-only `stream` and `background` fields are omitted from direct WebSocket events. Subscription credentials omit unsupported temperature, output-token caps and cache-retention controls, matching stock pi-ai. Normal API keys retain those supported request controls.

`websocketFallback: "error"` explicitly disables SSE recovery in Codex mode too. Direct mode always requires that policy. Upgrade rejection, oversized messages and exhausted retries remain visible errors rather than changing transport. An explicit direct request with `transport: "sse"` is rejected.

## What changes

- Cached WebSockets are the default. A matching completed request allows later calls to send only new input with `previous_response_id`. Changed history, tools, model or request settings require full input.
- Socket handshakes overlap final payload preparation. Connection identity includes credentials, endpoint, proxy and headers.
- WebSocket failures have bounded retries. Codex mode permits visible SSE fallback unless disabled. Upgrade-required and oversized-message failures keep SSE active for that session. Authentication fallback is limited to the current request. Direct mode never changes transport.
- In Codex mode, Responses Lite is automatic for supported models when a grammar tool is declared. Code and Notebook qualify through their ordinary tool declarations. Lite relocates tools and instructions into the input, uses the `functions` namespace and disables parallel tool calls. Ordinary function-only requests keep normal Responses formatting and parallel calls.
- Historical function and custom-tool calls keep their recorded family when current declarations change. Encrypted reasoning, native web and image items, cache usage and service-tier pricing remain available.

Configure Codex defaults with `transport`, `responsesLite`, `forceCachedWebSockets`, `originator` and `diagnostics`. Set `responsesLite: false` to disable Lite, or `true` only for a route known to support it. Per-request pi-ai options supply reasoning effort, service tier, verbosity, cancellation, timeouts and retries. Codex deliberately omits `maxTokens` because its endpoint rejects an output-token cap. Deferred generation is not supported. Named tool selection is available in direct mode, but not Codex mode.

`diagnostics(event)` receives transport decisions and usage counts without prompts, tool arguments, credentials or response IDs. Prewarm readiness and continuation reuse do not prove a prompt-cache hit. Only provider-reported cache usage does. This package makes no general latency or billing guarantee.

## Lifecycle

Durable supplies a persisted provider session ID for each conversation. Direct pi-ai callers should supply their own stable `sessionId`. State is isolated per provider instance and is not restored after a process restart.

Call `await provider.resetSession(sessionId)` when explicitly discarding a conversation's transport state. It cancels active work and clears sockets, continuation, canonical history and sticky fallback. New requests for that session are rejected until reset completes.

Close the provider when disposing the host, after stopping its Harness:

```ts
await harness.close(context);
await provider.close();
```

`close()` cancels and joins remaining streams, prewarms and owned connections. A closed provider rejects new work. Keep one provider alive across ordinary turns rather than recreating it for every request.

## Explicit prewarm and checkpoints

`provider.prewarm(model, context, options)` prepares a complete request and warms its WebSocket. Options require resolved `apiKey` and `sessionId`. `provider.prewarmPrepared(model, body, options)` accepts an already prepared final payload. The host must run its normal prompt and tool preparation first. Neither method knows about pending host edits.

Default prewarm uses `generate: false`. `mode: "keepalive"` explicitly generates a billable response on an isolated socket lane without advancing the main conversation. No idle timer or automatic generated keepalive is installed. Returned usage belongs to the caller's accounting, not a Durable generation task.

`provider.getCanonicalRequest(model, sessionId, apiKey, reconstructedInput)` exposes a validated completed-request snapshot for host-owned native checkpoints. `reconstructedInput` excludes Lite's leading tool and instruction items. Account, endpoint, model and history must match. A mismatch returns a decision without a body. This does not install a compaction policy, persist encrypted checkpoints or replace Durable's context management.

Lite prepares inline images with a native codec, a 2048-pixel dimension limit and a 2500-patch budget. Unsupported remote image URLs and undecodable images become explicit omission text, matching the source policy.

[Parity and validation](../../docs/parity/openai-responses.md) distinguish carried behavior, intentional fixes and live evidence.
