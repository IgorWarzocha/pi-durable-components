# View image for Pi Durable

`createViewImageTool(options)` creates a Durable `view_image` registration. Install it in the ordinary tool registry. Code and Notebook discover the same registration.

```ts
import { createRegistry } from "@earendil-works/pi-durable";
import { createViewImageTool } from "@howaboua/pi-durable-view-image";

// models is the same pi-ai Models collection supplied to Harness.open().
const registry = createRegistry();
registry.install({
  name: "images",
  tools: [createViewImageTool({ models, describeForTextModels: true })],
});
```

The tool accepts `{ path: string, detail?: "original" }`. Relative paths resolve through the conversation's `api.env`. `file_path` and `image_path` are repaired to `path`. A leading `@` is removed. The canonical `path` wins when aliases are also present.

PNG, JPEG and WebP return their original bytes after Rust image decoding validates the image through `@napi-rs/image@1.15.0`. GIF returns the first frame as PNG through `sharp@0.35.5`. Images are not resized or EXIF-rotated. Both native codecs receive bytes from the execution environment and do not read host paths.

Vision models receive native pi-ai image content. The Durable provider controls image detail on the wire. The accepted `detail: "original"` argument selects unchanged image bytes, not a transport override.

## Text-only models

Description is disabled by default. Enable `describeForTextModels` to return a description from a vision model, plus the image, path and description in `details.viewImageDescription`. The description call uses the injected Models collection for provider routing and authentication. No Pi extension context or provider auth shim is needed.

The default description model is `gpt-6-luna` in the caller's provider. Set `descriptionModel: { provider, modelId }` to use another configured vision model. Requests use low reasoning. Responses providers also receive low verbosity and automatic reasoning summaries through pi-ai's supported payload callback. Missing models, provider failures and empty descriptions are visible tool failures.

Cancellation follows the Durable invocation context. Description-enabled registrations are replay-unsafe because an interrupted provider request may already have incurred a charge. Registrations with description disabled are replay-safe.

## Validation

```sh
node --experimental-strip-types --test packages/view-image/test/*.test.ts
VIEW_IMAGE_REFERENCE_BINARY=/path/to/pinned/view_image \
  node --experimental-strip-types --test packages/view-image/test/differential.ts
```

The differential probe creates temporary fixtures and invokes the reference helper read-only. Original bytes, first-frame conversion and decoder acceptance evidence are recorded in [`docs/parity/view-image.md`](../../docs/parity/view-image.md).
