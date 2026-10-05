# Durable Web

Search the web and follow returned page references with the `web_run` tool. Requires Pi Durable, pi-ai and Chord 1.0.2, plus an authenticated Codex-compatible backend. Node is the default runtime; Cloudflare Workers can use native fetch.

```sh
npm install https://github.com/IgorWarzocha/pi-durable-components/releases/download/web-v0.3.2/howaboua-pi-durable-web-0.3.2.tgz
```

Install the bundle in your Durable registry, passing the same authenticated pi-ai Models collection used by your application:

```ts
import { createWebSearchExtension } from '@howaboua/pi-durable-web';

registry.install(createWebSearchExtension({ models }));
```

On Workers, pass `runtime: 'workerd'`. Native fetch uses the same permitted service-cookie, redirect, response-limit and cancellation policy as Node. It reads every `Set-Cookie` header separately and carries matching cookies into later calls and redirects. Cookies are restricted to the supported HTTPS ChatGPT hosts; login cookies are not imported. A Cloudflare challenge is reported, not solved or automatically retried.

The default jar lasts for the module's lifetime. For persistence across isolates, supply `cookieStore(provider, context)` with a server-owned `CodexCookieStore`, scoped to the resolved account and grant. `ChatGptCloudflareCookieStore` validates and snapshots the permitted state for host storage. Its snapshots contain secrets: never put them in tool results, conversation history, logs or browser storage. Cookie values are redacted from returned response bodies.

Node still honours proxy environment variables for every destination and closes its owned proxy agents. Workers cannot use Node's `ProxyAgent` or ambient `HTTP_PROXY`; a host with a configured egress service can supply `fetch` explicitly, such as a bound Worker service-binding fetch. Failure of that capability never falls back to direct network access. Workers use the explicit `model` option rather than `PI_CODEX_MODEL`, and identify their actual runtime in the Codex user-agent format.

Web needs Codex-compatible authentication. A direct ChatGPT subscription grant for `https://api.openai.com/v1` is not a Codex grant. The host must supply the appropriate subscription OAuth credential; it must not substitute a paid API key or expose authentication to guest code.

The bundle can use Codex authentication even when the conversation uses another provider. To register only the tool, use `createWebSearchTool({ models, allowCodexProviderFallback: true })` in your own extension. Ordinary registrations are discoverable by Code and Notebook without adapters.

For a custom Codex transport, pass `routes: normalizeCodexToolRouteConfig(config)` with the host-loaded `pi-codex-tools.json` value. Its provider keys select Codex transport and its model aliases select request models. An ordinary Responses backend needs `allowConfiguredProvider`. An explicit `resolveProvider` supplies hosted endpoints and authentication. Configured routes take precedence over that resolver. Web model selection supports `model` and `PI_CODEX_MODEL`.

Requests contain explicit commands, never conversation history. Returned references remain in `details.webRun`. Both runtimes strip cross-origin bearer credentials and limit responses to 8 MiB. Matching service cookies follow their domain and path policy. ChatGPT Cloudflare challenges and unavailable endpoints produce explicit errors. Interrupted calls are not replayed automatically.

See [parity evidence](../../docs/parity/web-imagegen.md) for source revisions and integration boundaries.
