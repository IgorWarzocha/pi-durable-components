# Pi Durable Dictation

Local Whisper dictation for Node.js 22.19 or later, using the native
`sherpa-onnx-node` runtime. The consuming app supplies model storage and selection.
This package does not capture microphone audio or register agent tools.

```sh
npm install https://github.com/IgorWarzocha/pi-durable-components/releases/download/v0.8.1/howaboua-pi-durable-dictation-0.8.1.tgz
```

```ts
import { createDictationService } from '@howaboua/pi-durable-dictation'

const dictation = createDictationService({
  modelDirectory: '/absolute/path/to/models/whisper',
  getSelectedModelId: () => 'tiny.en',
  onDownloadLog: (event) => console.log(event.message),
})

const install = await dictation.service.installDictationModel({ modelId: 'tiny.en' })
if (!install.ok) throw new Error(install.error ?? 'Model installation failed')

// Supply base64-encoded little-endian PCM16 mono audio, not a WAV container.
const result = await dictation.service.transcribeDictation({
  audioBase64,
  sampleRate: 16_000,
  language: 'en',
})

await dictation.dispose()
```

The service also exposes `getDictationState()`, `listDictationModels()` and
`removeDictationModel({modelId})`. Model presets are `tiny.en`, `base.en` and
`small.en`. Installation and transcription return structured results with an
`ok` flag and an `error` field. Calls after disposal reject.

`isBusy()` reports admitted work. Disposal aborts downloads, rejects queued
native operations and waits for active work. Native recognizer handles are
garbage-collected because sherpa provides no supported close operation.

Import browser-safe types from `@howaboua/pi-durable-dictation/contracts`, model
definitions from `/models`, and language, PCM and duration helpers from
`/helpers`. Keep the main entry and native dependency on the server.

## Configuration

Managed downloads use `modelDirectory`. Pass `modelSearchDirectories` for an
ordered list of additional discovery roots. If omitted, discovery uses
`PI_SHERPA_ONNX_MODEL_DIR` followed by `PI_DICTATION_MODEL_DIR`. An explicit
empty list disables those environment roots. The managed directory is appended
and duplicate roots are removed. Selected managed models retain their existing
priority over additional roots.

Pass `language`, `numThreads` or `provider` to override
`PI_SHERPA_ONNX_LANGUAGE`, `PI_SHERPA_ONNX_NUM_THREADS` or
`PI_SHERPA_ONNX_PROVIDER`. Explicit thread counts must be positive safe integers.
Without a thread setting, recognition uses available parallelism capped at four.
The default provider is `cpu`. Language falls back to the resolved model's
language, then the transcription request. Explicit blank language or provider
values skip their environment setting and use those defaults.

App-specific configuration names belong in the consuming adapter. Translate them
to these options rather than relying on app environment aliases in this package.

Supported native platforms are macOS arm64 and x64, Linux arm64 and x64, and
Windows ia32 and x64. Missing models, unsupported platforms and native loading
errors are reported by `getDictationState()`.
