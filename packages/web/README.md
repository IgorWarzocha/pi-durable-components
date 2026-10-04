# Durable Web

Search the web and follow returned page references with the `web_run` tool. Requires Node.js and Pi Durable, pi-ai and Chord 1.0.2, plus an authenticated Codex-compatible backend.

```sh
npm install https://github.com/IgorWarzocha/pi-durable-components/releases/download/v0.1.0/howaboua-pi-durable-web-0.1.0.tgz
```

Install the bundle in your Durable registry, passing the same authenticated pi-ai Models collection used by your application:

```ts
import { createWebSearchExtension } from '@howaboua/pi-durable-web';

registry.install(createWebSearchExtension({ models }));
```

The bundle can use Codex authentication even when the conversation uses another provider. To register only the tool, use `createWebSearchTool({ models, allowCodexProviderFallback: true })` in your own extension. Ordinary registrations are discoverable by Code and Notebook without adapters.

For a custom Codex transport, pass `routes: normalizeCodexToolRouteConfig(config)` with the host-loaded `pi-codex-tools.json` value. Its provider keys select Codex transport and its model aliases select request models. An ordinary Responses backend needs `allowConfiguredProvider`. An explicit `resolveProvider` supplies hosted endpoints and authentication. Configured routes take precedence over that resolver. Web model selection supports `model` and `PI_CODEX_MODEL`.

Requests contain explicit commands, never conversation history. Returned references remain in `details.webRun`. The transport honors proxy environment variables on each redirect, strips cross-origin credentials and limits responses to 8 MiB. ChatGPT Cloudflare challenges and unavailable endpoints produce explicit errors. Interrupted calls are not replayed automatically.

See [parity evidence](../../docs/parity/web-imagegen.md) for source revisions and integration boundaries.
