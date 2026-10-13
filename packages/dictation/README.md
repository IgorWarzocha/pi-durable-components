# Pi Durable Dictation

Local Whisper dictation for Node.js 22.19 or later, using the native
`sherpa-onnx-node` runtime. The consuming app supplies model storage and selection.
This package does not capture microphone audio or register agent tools.

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

Managed downloads use `modelDirectory`. Additional model discovery locations
can be set with `PI_SHERPA_ONNX_MODEL_DIR` and `PI_DICTATION_MODEL_DIR`.
`PI_SHERPA_ONNX_NUM_THREADS`, `PI_SHERPA_ONNX_PROVIDER` and
`PI_SHERPA_ONNX_LANGUAGE` configure recognition. Each setting retains its
`HOWCODE_` equivalent as a compatibility alias, with the `PI_` setting taking
precedence.

Supported native platforms are macOS arm64 and x64, Linux arm64 and x64, and
Windows ia32 and x64. Missing models, unsupported platforms and native loading
errors are reported by `getDictationState()`.
