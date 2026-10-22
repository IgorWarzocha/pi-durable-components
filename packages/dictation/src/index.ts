import type { DictationService, DictationServiceOptions } from "./contracts.ts";
import { createModelManagement } from "./model-management.ts";
import { createModelResolution } from "./model-resolution.ts";
import { createTranscriptionService } from "./sherpa-onnx.ts";
import { createSherpaRuntime } from "./sherpa-runtime.ts";

export type * from "./contracts.ts";

/** Owns native recognizers, model operations and their shutdown within one instance. */
export function createDictationService(options: DictationServiceOptions) {
	if (!options.modelDirectory.trim())
		throw new Error("A dictation model directory is required.");
	if (
		options.numThreads !== undefined &&
		(!Number.isSafeInteger(options.numThreads) || options.numThreads <= 0)
	)
		throw new Error("Dictation numThreads must be a positive safe integer.");
	const resolution = createModelResolution(options);
	const runtime = createSherpaRuntime(options);
	const models = createModelManagement(options, resolution, runtime);
	const transcription = createTranscriptionService(
		resolution,
		runtime,
		options,
	);
	const downloads = new AbortController();
	const pending = new Set<Promise<unknown>>();
	let stopping = false;
	let disposal: Promise<void> | undefined;
	let exclusive: Promise<unknown> = Promise.resolve();

	function run<A>(evaluate: () => Promise<A>, serialize = false): Promise<A> {
		if (stopping)
			return Promise.reject(new Error("Dictation service is shutting down."));
		const task = serialize
			? exclusive.then(() => {
					downloads.signal.throwIfAborted();
					return evaluate();
				})
			: Promise.resolve().then(evaluate);
		if (serialize) exclusive = task.catch(() => undefined);
		pending.add(task);
		void task.then(
			() => pending.delete(task),
			() => pending.delete(task),
		);
		return task;
	}

	const service: DictationService = {
		getDictationState: () => run(transcription.getDictationState),
		listDictationModels: () =>
			run(models.listManagedAndConfiguredDictationModels),
		installDictationModel: ({ modelId }) =>
			run(
				() => models.installManagedDictationModel(modelId, downloads.signal),
				true,
			),
		removeDictationModel: ({ modelId }) =>
			run(() => models.removeManagedDictationModel(modelId), true),
		transcribeDictation: (request) =>
			run(() => transcription.transcribeDictation(request), true),
	};

	return {
		service,
		isBusy: () => pending.size > 0,
		dispose(): Promise<void> {
			if (!disposal) {
				stopping = true;
				downloads.abort();
				disposal = Promise.allSettled(pending).then(() => {
					// sherpa-onnx handles are GC-owned; the native API exposes no close operation.
					runtime.resetRecognizerCache();
				});
			}
			return disposal;
		},
	};
}
