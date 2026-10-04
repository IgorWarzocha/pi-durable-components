import type {
	JsonObject,
	ToolExecutionResult,
} from "@earendil-works/pi-durable";
import type { CellObservation } from "../../execution/src/index.ts";
import { runtimeResult } from "./result.ts";
import type {
	RuntimeContentItem,
	RuntimeResponse,
} from "./runtime-contract.ts";

/** One observation window, including delivery backpressure and bounded diagnostic traces. */
export class CodeCellOutput {
	private readonly maxTokens: number;
	private delivery:
		| { delivered: boolean; promise: Promise<void>; release(): void }
		| undefined;
	private readonly output: RuntimeContentItem[] = [];
	private remainingChars = 0;
	private imageChars = 0;
	private imageCount = 0;
	private omittedImages = 0;
	private truncated = false;
	private revision = 0;
	private readonly notifications: RuntimeContentItem[] = [];
	private append(items: RuntimeContentItem[]): void {
		for (const item of items) {
			if (item.type === "input_image") {
				if (
					this.imageCount >= 4 ||
					this.imageChars + item.image_url.length > 16 * 1024 * 1024
				) {
					this.omittedImages++;
				} else {
					this.output.push(item);
					this.imageCount++;
					this.imageChars += item.image_url.length;
				}
			} else if (item.text.length === 0) {
				continue;
			} else if (this.remainingChars > 0) {
				const text = item.text.slice(0, this.remainingChars);
				this.remainingChars -= text.length;
				this.output.push({ ...item, text });
				if (text.length < item.text.length && !this.truncated) {
					this.truncated = true;
					this.output.push({ type: "input_text", text: "[Output truncated]" });
				}
			} else if (!this.truncated) {
				this.truncated = true;
				this.output.push({ type: "input_text", text: "[Output truncated]" });
			}
		}
	}
	private readonly traces: JsonObject[] = [];
	private droppedTraceCount = 0;
	private current: RuntimeResponse = {
		kind: "yielded",
		cellId: "pending",
		contentItems: this.output,
	};
	constructor(maxTokens: number) {
		this.maxTokens = maxTokens;
		this.remainingChars = maxTokens * 4;
	}
	result(): ToolExecutionResult {
		const result = runtimeResult(
			{
				...this.current,
				contentItems: [
					...this.output,
					...(this.omittedImages
						? [
								{
									type: "input_text" as const,
									text: `[${this.omittedImages} code-mode images omitted]`,
								},
							]
						: []),
				],
			},
			this.maxTokens,
		);
		return {
			...result,
			details: {
				runtimeCellId: this.current.cellId,
				status: this.current.kind,
				codeMode: true,
				traces: this.traces.map((trace) => ({ ...trace })),
				droppedTraceCount: this.droppedTraceCount,
				deliveryRevision: this.revision,
				...(this.current.errorText
					? { scriptError: this.current.errorText }
					: {}),
			},
		};
	}

	notify(text: string): void {
		this.notifications.push({ type: "input_text", text });
		if (this.notifications.length > 100) this.notifications.shift();
	}
	trace(id: string, name: string, input: unknown) {
		if (this.traces.length === 50) {
			this.traces.shift();
			this.droppedTraceCount++;
		}
		const trace: JsonObject = {
			id,
			name,
			input: JSON.stringify(input).slice(0, 16_384),
			status: "running",
		};
		this.traces.push(trace);
		return {
			done(result: ToolExecutionResult): void {
				trace["status"] = "done";
				trace["result"] = JSON.stringify(result).slice(0, 16_384);
			},
			failed(error: unknown): void {
				trace["status"] = "error";
				trace["error"] = (
					error instanceof Error ? error.message : String(error)
				).slice(0, 16_384);
			},
		};
	}
	replaceObservation(response: RuntimeResponse): void {
		this.current = response;
		this.output.length = 0;
		this.remainingChars = this.maxTokens * 4;
		this.imageChars = 0;
		this.imageCount = 0;
		this.omittedImages = 0;
		this.truncated = false;
		this.append([...this.notifications.splice(0), ...response.contentItems]);
		this.revision++;
		let release!: () => void;
		const promise = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.delivery = { delivered: false, promise, release };
	}
	get hasOutput(): boolean {
		return this.output.length > 0;
	}
	get delivered(): Promise<void> {
		if (!this.delivery) throw new Error("No Code observation to deliver");
		return this.delivery.promise;
	}
	acknowledge(revision: number): boolean {
		if (!this.delivery || this.revision !== revision) return true;
		const fresh = !this.delivery.delivered;
		this.delivery.delivered = true;
		this.delivery.release();
		return fresh;
	}
}

/** Project one acknowledged durable snapshot with the caller's own output budget. */
export function observeCodeCell(
	observation: CellObservation,
	maxTokens: number,
	acknowledge: (taskId: number, revision: number) => boolean,
): ToolExecutionResult {
	const details = observation.result.details;
	const revision =
		details !== null && typeof details === "object" && !Array.isArray(details)
			? details["deliveryRevision"]
			: undefined;
	const fresh =
		typeof revision !== "number" || acknowledge(observation.cellId, revision);
	let remaining = maxTokens * 4;
	let truncated = false;
	const content: NonNullable<ToolExecutionResult["content"]> = [];
	for (const item of fresh || observation.status !== "running"
		? (observation.result.content ?? [])
		: []) {
		if (item.type !== "text") {
			content.push(item);
			continue;
		}
		if (remaining <= 0) {
			if (!truncated) content.push({ ...item, text: "[Output truncated]" });
			truncated = true;
		} else if (item.text.length > remaining) {
			content.push({
				...item,
				text: `${item.text.slice(0, remaining)}\n[Output truncated]`,
			});
			remaining = 0;
			truncated = true;
		} else {
			content.push(item);
			remaining -= item.text.length;
		}
	}
	if (observation.status === "running")
		content.unshift({
			type: "text",
			text: `Still running (exec cell "${observation.cellId}"). Use wait near expected completion`,
		});
	if (!content.length) content.push({ type: "text", text: "OK" });
	return {
		...observation.result,
		content,
		details: {
			...(details !== null &&
			typeof details === "object" &&
			!Array.isArray(details)
				? details
				: {}),
			cellId: observation.cellId,
			status: observation.status,
		},
	};
}
