# view_image parity

## Pinned sources

- `howaboua-pi-stuff` revision `b2006db9def12c373ae48e70044d30f7d6b7e34f`.
- `packages/pi-codex-conversion/src/tools/view-image/tool.ts`, `output.ts` and `rust/main.rs`.
- `src/tools/rust/crates/codex-utils-image/lib.rs` and its `Cargo.toml`.
- Image utility upstream pin `openai/codex b545c94041017d000e2c8b2f6272705d21b85dfb`.
- Native integration baseline `@earendil-works/pi-durable`, `pi-ai` and Chord `1.0.2`.
- PNG/JPEG/WebP decoder `@napi-rs/image@1.15.0`, released source revision `7bad478bfe647bca75d4c05db8726ca3d5335e80` of `Brooooooklyn/Image`.
- GIF codec `sharp@0.35.5`, libvips `8.18.7`.

The source checkouts were not changed. The probe invokes the existing `src/tools/target/release/view_image` binary.

## Preserved behavior

Harness evidence below records port-time validation. The registration, description and error-branch tours were later pruned from the default suite. Codec differential and opt-in live image validation remain available.

| Contract | Evidence |
| --- | --- |
| `path`, `file_path`, `image_path` precedence and leading `@` repair | Real Durable Harness registration calls |
| Optional `detail` accepts only `original`, with null treated as omitted | Actual Harness calls exercise repair and validation |
| Conversation-relative and absolute paths, symlink following, file-only input | Harness uses `api.env`; NodeExecutionEnv fixture includes a symlink and a directory symlink |
| PNG, JPEG, WebP source bytes preserved after decoding | Byte-for-byte differential comparison against helper, including ICC and orientation metadata |
| Original mode does not resize or rotate | Differential 2200-pixel PNG and orientation-tagged PNG, JPEG and WebP |
| GIF converted to first-frame PNG | Animated two-frame fixture compared by decoded dimensions, alpha and visible RGB pixels |
| Four compiled formats only | Signature gate refuses BMP and extra native-codec formats; source Cargo enables only PNG, JPEG, GIF and WebP |
| Full pixel validation before returning content | Truncated PNG and signature-only PNG rejected; napi metadata performs a complete Rust image decode, GIF explicitly decodes pixels |
| Native vision image content | Actual Harness records `ImageContent` with no provider-specific fields |
| Text-model description opt-in, default `gpt-6-luna`, low reasoning and verbosity, empty/error failures | Harness routes through injected Models; low reasoning checked at provider boundary, supported Responses payload controls traced in source |
| Description details retain image, supplied path and description | Harness result-entry assertions |
| Cancellation and uncertain description outcomes | Source uses the invocation AbortSignal in Models and native codec APIs; description-enabled registration declares unsafe replay |
| Content-addressed bounded cache | `src/codec.ts` keys bytes by SHA-1, limits 32 entries and 64 MiB encoded bytes |

The 1 GiB `MAX_PROMPT_IMAGE_INPUT_BYTES` guard belongs to `load_data_url_for_prompt`. Neither the Rust file helper nor `load_for_prompt_bytes` applies that guard to file bytes. This tool does not add an unrelated source-size policy. Sharp's default pixel-count limit is disabled. Normal memory allocation and decoder failures remain visible.

GIF's Rust decoder exposes no ICC or EXIF metadata. Other formats retain all source bytes, so their metadata is unchanged. This implementation does not introduce EXIF rotation or resize-only color-profile copying.

## Accepted native-provider difference

Igor chose Durable provider compatibility rather than a literal old image-detail transport flag. Native pi-ai `ImageContent` contains `type`, `data` and `mimeType`, but no `detail`. The tool accepts `detail: "original"` and preserves original source bytes. It does not add an unsupported image property or rewrite the caller's provider payload.

Pi-ai `1.0.2` owns the Responses serialization in `api/openai-responses-shared.ts`. `convertToolResultOutput` and the user-image branch of `convertResponsesMessages` choose `detail: "auto"`. This is not exact old transport parity. The description request uses native image content too. Its own supported `onPayload` callback only adds low verbosity and automatic reasoning summaries on Responses APIs.

Provider authentication, stream handling and model capability lookup belong to injected pi-ai Models. The old private Codex SSE/auth helpers and Pi TUI renderer are not carried across. Description usage is returned to Durable's tool-usage accounting.

## Codec differential evidence

PNG, JPEG and WebP use the same Rust image decoder family as the helper, rather than libvips. In the released napi source, `packages/binding/src/transformer.rs` calls `image::load_from_memory_with_format`. Its `metadata(false, signal)` invokes this complete pixel decode, not a header-only read. No rotation is staged. The source helper's lockfile pins Rust `image` to `0.25.10`; the napi dependency declares `image 0.25`. The exact transitive crate version in the distributed napi binary is not claimed.

The source differential probe now verifies the previously mismatched malformed cases too:

- A valid 96-byte PNG cut to 86 bytes lacks the complete IEND chunk. Both the helper and component reject it.
- A JPEG missing its final `0xD9` byte is accepted by both decoders. The component returns precisely the supplied bytes.
- A WebP missing its final alignment byte is accepted by both decoders. The component returns precisely the supplied bytes.

The recorded PNG case failed before switching validation from sharp to napi and passes after the switch. All three cases were also probed directly against the installed napi binary before changing the component. No missing bytes are synthesized and no error is hidden behind a fallback.

The napi build omits GIF support. Sharp remains the explicit GIF first-frame decoder and PNG encoder. The animated fixture agrees with the helper on dimensions, alpha and visible RGB pixels. GIF PNG encoding is not byte-identical between codecs. RGB underneath fully transparent pixels is not rendering content and is excluded from the pixel comparison.

## Checks

Earlier registration validation used `node:test`, the real Durable Harness with MemoryStorage, and pi-ai's faux provider. The optional `packages/view-image/test/differential.ts` probe is outside the default `*.test.ts` gate. It requires `VIEW_IMAGE_REFERENCE_BINARY` and visibly skips if the helper is unavailable. The codec probe needs no billed provider request.

The coordinating agent also completed the live image workflow in `scripts/smoke-live.mjs`: generate an image, view it through Durable, assert byte equality with the saved file, then edit the recent image. The earlier all-tool toolkit workflow passed with both Code and Notebook, invoking ordinary `view_image` and verifying delivery of the unchanged PNG to the model. That image-delivery tour is not retained.
