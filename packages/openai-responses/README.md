# OpenAI Responses

Our optimised Codex subscription provider for Pi Durable. It carries Pi Codex's cached WebSocket transport, validated continuation, Responses Lite, grammar tools and stream recovery without the coding-agent extension.

This targets ChatGPT's Codex endpoint, not the standard OpenAI API. Use pi-ai's ordinary OpenAI provider for API-key billing or general Responses-compatible servers.

## Install

Requires Node.js 22.19 or newer and pi-ai 1.0.2. Linux is the tested platform.

```sh
npm install https://github.com/IgorWarzocha/pi-durable-components/releases/download/v0.3.0/howaboua-pi-durable-openai-responses-0.3.0.tgz
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

## What changes

- Cached WebSockets are the default. A matching completed request allows later calls to send only new input with `previous_response_id`. Changed history, tools, model or request settings require full input.
- Socket handshakes overlap final payload preparation. Connection identity includes credentials, endpoint, proxy and headers.
- WebSocket failures have bounded retries and visible SSE fallback. Upgrade-required and oversized-message failures keep SSE active for that session. Authentication fallback is limited to the current request.
- Responses Lite is automatic for supported models when a grammar tool is declared. Code and Notebook qualify through their ordinary tool declarations. Lite relocates tools and instructions into the input, uses the `functions` namespace and disables parallel tool calls. Ordinary function-only requests keep normal Responses formatting and parallel calls.
- Historical function and custom-tool calls keep their recorded family when current declarations change. Encrypted reasoning, native web and image items, cache usage and service-tier pricing remain available.

Configure defaults with `transport`, `responsesLite`, `forceCachedWebSockets`, `originator` and `diagnostics`. Set `responsesLite: false` to disable Lite, or `true` only for a route known to support it. Per-request pi-ai options supply reasoning effort, service tier, verbosity, cancellation, timeouts and retries. `maxTokens` is deliberately not sent because the Codex endpoint rejects an output-token cap. Deferred generation and named tool selection are not supported.

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
