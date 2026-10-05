/** Trusted host limits. Guests cannot raise them through exec or module arguments. */
export interface WorkerCodeLimits {
	heapBytes: number;
	stackBytes: number;
	fuel: number;
	maxJobs: number;
	maxCalls: number;
	maxPendingCalls: number;
	maxSourceBytes: number;
	maxModuleBytes: number;
	maxModules: number;
	maxArgumentBytes: number;
	maxResultBytes: number;
	maxOutputBytes: number;
	waitMs: number;
}

export const DEFAULT_WORKER_CODE_LIMITS: Readonly<WorkerCodeLimits> =
	Object.freeze({
		heapBytes: 8 * 1024 * 1024,
		stackBytes: 256 * 1024,
		fuel: 64,
		maxJobs: 4096,
		maxCalls: 128,
		maxPendingCalls: 32,
		maxSourceBytes: 65536,
		maxModuleBytes: 262144,
		maxModules: 128,
		maxArgumentBytes: 32768,
		maxResultBytes: 131072,
		maxOutputBytes: 262144,
		waitMs: 30000,
	});

export function workerLimits(
	input: Partial<WorkerCodeLimits> = {},
): Readonly<WorkerCodeLimits> {
	const limits = { ...DEFAULT_WORKER_CODE_LIMITS, ...input };
	for (const key of Object.keys(limits) as (keyof WorkerCodeLimits)[]) {
		const value = limits[key];
		const minimum =
			key === "heapBytes" ? 256 * 1024 : key === "stackBytes" ? 16 * 1024 : 1;
		if (
			!(key in DEFAULT_WORKER_CODE_LIMITS) ||
			!Number.isSafeInteger(value) ||
			value < minimum ||
			value > DEFAULT_WORKER_CODE_LIMITS[key]
		)
			throw new Error(
				`Invalid Worker Code limit ${key}. Expected an integer from ${minimum} to ${DEFAULT_WORKER_CODE_LIMITS[key]}`,
			);
	}
	return Object.freeze(limits);
}

export function boundedString(
	value: string,
	maxBytes: number,
	label: string,
): string {
	if (
		value.length > maxBytes ||
		new TextEncoder().encode(value).byteLength > maxBytes
	)
		throw new Error(`${label} byte limit exceeded`);
	return value;
}

export function boundedJson(
	value: unknown,
	maxBytes: number,
	label: string,
): string {
	const serialized = JSON.stringify(value);
	if (serialized === undefined) throw new Error(`${label} must be JSON`);
	return boundedString(serialized, maxBytes, label);
}
