import type { BrowserArtifactStore } from "./artifact-store.ts";

const RESULT_TTL_MS = 60 * 60 * 1_000;
const SCREENSHOT_TTL_MS = 24 * 60 * 60 * 1_000;
const TEXT_BUDGET_BYTES = 32_000;

function chunkForJson(
	value: string,
	offset = 0,
	budget = TEXT_BUDGET_BYTES,
): { text: string; end: number } {
	let bytes = 2;
	let end = offset;
	for (const character of value.slice(offset)) {
		const next = Buffer.byteLength(JSON.stringify(character)) - 2;
		if (bytes + next > budget) break;
		bytes += next;
		end += character.length;
	}
	return { text: value.slice(offset, end), end };
}

export class BrowserArtifacts {
	readonly store: BrowserArtifactStore;
	constructor(store: BrowserArtifactStore) {
		this.store = store;
	}
	screenshotTarget(request: {
		ref_id: string;
		id?: number | undefined;
		selector?: string | undefined;
	}) {
		const suffix =
			request.id !== undefined
				? `-element-${request.id}`
				: request.selector
					? "-element"
					: "";
		const safeRef = request.ref_id.slice(0, 12).replace(/[^A-Za-z0-9_-]/g, "_");
		const name = `browser-${safeRef}${suffix}-${crypto.randomUUID()}.png`;
		return {
			file: this.store.path(name),
			write: (data: Uint8Array) => this.store.write(name, data),
		};
	}
	async prune(now = Date.now()): Promise<number> {
		let removed = 0;
		for (const entry of await this.store.entries()) {
			if (!/^(?:result-[a-f0-9-]{36}\.txt|browser-.*\.png)$/.test(entry.name))
				continue;
			const age = entry.name.startsWith("result-")
				? RESULT_TTL_MS
				: SCREENSHOT_TTL_MS;
			if (now - entry.mtimeMs > age) {
				await this.store.remove(entry.name);
				removed++;
			}
		}
		return removed;
	}
	async limitedText(
		base: Record<string, unknown>,
		field: string,
		value: string,
	): Promise<Record<string, unknown>> {
		const chunk = chunkForJson(value);
		if (chunk.end >= value.length) return { ...base, [field]: value };
		const handle = crypto.randomUUID();
		await this.store.write(`result-${handle}.txt`, value);
		return {
			...base,
			[field]: chunk.text,
			truncated: true,
			omitted_chars: value.length - chunk.end,
			result_handle: handle,
			next_offset: chunk.end,
		};
	}

	async readCachedResult(request: {
		handle: string;
		offset: number;
	}): Promise<Record<string, unknown>> {
		let value: string;
		try {
			value = await this.store.read(`result-${request.handle}.txt`);
		} catch (error) {
			if (
				error &&
				typeof error === "object" &&
				"code" in error &&
				(error.code === "ENOENT" || error.code === "not_found")
			) {
				throw new Error(
					`result handle not found: ${request.handle}; check the host or rerun the original action`,
				);
			}
			throw error;
		}
		if (request.offset > value.length) {
			throw new Error(
				`offset ${request.offset} exceeds result length ${value.length}`,
			);
		}
		const chunk = chunkForJson(value, request.offset);
		const complete = chunk.end >= value.length;
		if (complete) {
			await this.store.remove(`result-${request.handle}.txt`);
		}
		return {
			handle: request.handle,
			offset: request.offset,
			text: chunk.text,
			complete,
			...(complete ? {} : { next_offset: chunk.end }),
		};
	}

	async discardCachedResult(handle: string): Promise<Record<string, unknown>> {
		await this.store.remove(`result-${handle}.txt`);
		return { discarded: handle };
	}
}
