export type DictationState = {
	available: boolean;
	reason: "missing-model" | "runtime-error" | "unsupported-platform" | null;
	runtime: "sherpa-onnx-node" | null;
	modelDirectory: string | null;
	modelId: string | null;
	language: string | null;
	error: string | null;
};

export type DictationModelId = "tiny.en" | "base.en" | "small.en";

export type DictationModelSummary = {
	id: DictationModelId;
	name: string;
	description: string;
	downloadSizeBytes: number;
	downloadSizeLabel: string;
	installed: boolean;
	managed: boolean;
	selected: boolean;
};

export type DictationModelInstallResult = {
	ok: boolean;
	modelId: DictationModelId;
	error: string | null;
};

export type DictationModelRemoveResult = {
	ok: boolean;
	modelId: DictationModelId;
	error: string | null;
};

export type DictationTranscriptionRequest = {
	audioBase64: string;
	sampleRate: number;
	language?: string | null | undefined;
};

export type DictationTranscriptionResult = {
	ok: boolean;
	text: string;
	runtime: "sherpa-onnx-node" | null;
	modelDirectory: string | null;
	modelId: string | null;
	language: string | null;
	error: string | null;
};

export type DictationDownloadEvent = {
	type: "dictation-download-log";
	modelId: DictationModelId;
	message: string;
	at: string;
	done: boolean;
	isError: boolean;
};
export type DictationService = {
	getDictationState(): Promise<DictationState>;
	listDictationModels(): Promise<DictationModelSummary[]>;
	installDictationModel(request: {
		modelId: DictationModelId;
	}): Promise<DictationModelInstallResult>;
	removeDictationModel(request: {
		modelId: DictationModelId;
	}): Promise<DictationModelRemoveResult>;
	transcribeDictation(
		request: DictationTranscriptionRequest,
	): Promise<DictationTranscriptionResult>;
};
export type DictationServiceOptions = {
	/** Native filesystem directory owned by this service for managed Whisper models. */
	modelDirectory: string;
	/** Ordered discovery roots, replacing PI_* model directories when supplied. The managed root is appended. */
	modelSearchDirectories?: readonly string[];
	/** Overrides PI_SHERPA_ONNX_LANGUAGE. Blank uses the model or request language. */
	language?: string;
	/** Positive integer overriding PI_SHERPA_ONNX_NUM_THREADS. */
	numThreads?: number;
	/** Overrides PI_SHERPA_ONNX_PROVIDER. Blank uses cpu. */
	provider?: string;
	getSelectedModelId: () => DictationModelId | null;
	onDownloadLog?: (event: DictationDownloadEvent) => void;
};
