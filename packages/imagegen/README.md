# Durable Image Generation

Generate images or edit local and recent conversation images with `imagegen`. Requires Node.js and Pi Durable, pi-ai and Chord 1.1.0, an authenticated Codex-compatible image backend and a conversation ExecutionEnv.

```sh
npm install https://github.com/IgorWarzocha/pi-durable-components/releases/download/v0.5.0/howaboua-pi-durable-imagegen-0.5.0.tgz
```

Install the bundle with your authenticated pi-ai Models collection. Provide a conversation reader if recent-image edits should be available:

```ts
import { createImageGenerationExtension } from '@howaboua/pi-durable-imagegen';

registry.install(createImageGenerationExtension({
  models,
  conversation: (id, context) => harness.conversation(id, context),
}));
```

Configure `Harness.open({ models, registry, env })` with your conversation environment. `createImageGenerationTool` also registers in an ordinary custom extension. Code and Notebook discover the registration without adapters.

Without selectors, the tool generates a new image. Local edits validate PNG, JPEG, GIF or WebP bytes. Recent edits select up to five images from the active model context after edits and compaction. Durable 1.1.0's tool handle does not expose a context reader, so the explicit `conversation` capability is required for that selector. Missing context access fails visibly.

Generated images and `latest.png` are saved through ExecutionEnv under the nearest workspace `.git` root in `.pi/openai-codex-images`. Results include paths, image attachments, response metadata and reported usage when present. Billing costs are not invented. Text-only conversation models receive paths without image attachments.

Custom transports accept host-loaded `routes: normalizeCodexToolRouteConfig(config)`, `allowConfiguredProvider` or an explicit `resolveProvider`. The bundle allows Codex auth fallback by default. Requests use `gpt-image-2.5`, automatic size and quality, and an opaque background unless transparency is requested. Network responses are bounded to 64 MiB and proxy routing is checked at every redirect.

Calls execute sequentially and are never replayed automatically after interruption. A lost response can leave the remote outcome unknown. Artifact failure after a successful response is reported separately. Do not automatically repeat either request.

See [parity evidence](../../docs/parity/web-imagegen.md) for source revisions and integration boundaries.

## Headless presentations

Available in local-development builds, not release 0.5.0.

The browser-safe `@howaboua/pi-durable-imagegen/presentation` entry exports `imagegenCapability`, `imagegenSummary`, `imagegenDetail` and `createImagegenPresentationState`. The constructor projects an existing tool receipt into saved artifact paths and image counts without loading image bytes.

Start with `createImagegenPresentationState(output)`. Its `detail` is `null`, meaning not acquired. Bind the capability once and select either presentation. A summary request for `detail` is a host callback, not a tool call. The host may publish the already recorded body on demand. Empty acquired results remain distinct from `null`.

These readonly receipt capabilities expose no actions or streams. They do not register tools, load artifacts, authenticate, or replay operations. The host owns binding, authorization and any ordinary tool invocation. Never repeat an interrupted side effect to populate a presentation.
