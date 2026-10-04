/*
 * MIT License. Copyright (c) 2025 Mario Zechner.
 * Derived from pi-durable src/harness/output.ts at f5d20047b3ad43d068a8eb61bd4e1f193bedbce6.
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

/** Minimum pause between progress commits; each commit also buys a pause proportional to what it wrote. */
const MIN_PROGRESS_INTERVAL_MS = 100;
const PROGRESS_BYTES_PER_SECOND = 100 * 1024;

type ProgressWaiter = {
	promise: Promise<void>;
	resolve(): void;
	reject(error: unknown): void;
};

/**
 * Adaptive progress commits, like the environment's shell output capture: the first change after an idle period
 * commits at once; each commit then delays the next by at least 100 ms and by its written size at 100 KiB/s. At most
 * one commit is in flight; changes made meanwhile coalesce into the next one.
 */
export class Progress {
	readonly #write: () => Promise<number>;
	readonly #onError: (error: unknown) => void;
	#waiters: ProgressWaiter[] = [];
	#timer: ReturnType<typeof setTimeout> | undefined;
	#inFlight: Promise<void> | undefined;
	#nextAt = 0;
	#dirty = false;
	#stopped = false;

	constructor(write: () => Promise<number>, onError: (error: unknown) => void) {
		this.#write = write;
		this.#onError = onError;
	}

	/** Schedule a commit. */
	mark(): void {
		this.#dirty = true;
		this.#schedule();
	}

	/** Schedule a commit; the promise settles with the commit that includes this change. */
	markAndWait(): Promise<void> {
		let resolve!: () => void;
		let reject!: (error: unknown) => void;
		const promise = new Promise<void>((yes, no) => {
			resolve = yes;
			reject = no;
		});
		const waiter: ProgressWaiter = { promise, resolve, reject };
		this.#waiters.push(waiter);
		this.mark();
		return waiter.promise;
	}

	/** Stop committing and wait for the commit in flight; returns the waiters the final commit must settle. */
	async stop(): Promise<ProgressWaiter[]> {
		this.#stopped = true;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		await this.#inFlight;
		return this.#waiters.splice(0);
	}

	#schedule(): void {
		if (
			this.#stopped ||
			this.#timer !== undefined ||
			this.#inFlight !== undefined
		)
			return;
		const wait = this.#nextAt - Date.now();
		if (wait <= 0) this.#flush();
		else
			this.#timer = setTimeout(() => {
				this.#timer = undefined;
				this.#flush();
			}, wait);
	}

	#flush(): void {
		if (this.#stopped || !this.#dirty) return;
		this.#dirty = false;
		const waiters = this.#waiters.splice(0);
		const started = Date.now();
		this.#inFlight = this.#write()
			.then(
				(bytes) => {
					this.#nextAt =
						started +
						Math.max(
							MIN_PROGRESS_INTERVAL_MS,
							(bytes * 1000) / PROGRESS_BYTES_PER_SECOND,
						);
					for (const waiter of waiters) waiter.resolve();
				},
				(error: unknown) => {
					this.#nextAt = started + MIN_PROGRESS_INTERVAL_MS;
					for (const waiter of waiters) waiter.reject(error);
					this.#onError(error);
				},
			)
			.finally(() => {
				this.#inFlight = undefined;
				if (this.#dirty) this.#schedule();
			});
	}
}
