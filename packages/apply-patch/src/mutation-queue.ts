import type { Context } from "@earendil-works/chord";
import { awaitWithContext } from "@earendil-works/chord/context";
import { type ExecutionEnv, getOrThrow } from "@earendil-works/pi-durable/env";

// Process-local ownership. Environment ids, not environment object identity, name a filesystem.
const tails = new Map<string, Promise<void>>();

export function pathIdentity(path: string): string {
	return /^[A-Za-z]:[\\/]|^\\\\/.test(path)
		? path.replace(/[A-Z]/g, (ch) => ch.toLowerCase())
		: path;
}

async function canonical(
	env: ExecutionEnv,
	path: string,
	context: Context,
): Promise<string> {
	const result = await env.canonicalPath(path, context);
	if (result.ok) return result.value;
	if (result.error.code !== "not_found") throw result.error;
	const parent = getOrThrow(await env.joinPath([path, ".."], context));
	if (parent === path || !path.startsWith(parent)) return path;
	const name = path.slice(parent.length + (/[/\\]$/.test(parent) ? 0 : 1));
	return getOrThrow(
		await env.joinPath([await canonical(env, parent, context), name], context),
	);
}

export async function withMutationKeys<T>(
	env: ExecutionEnv,
	paths: string[],
	context: Context,
	run: () => Promise<T>,
	warnings: string[] = [],
): Promise<T> {
	const keys = new Set<string>();
	for (const path of paths) {
		keys.add(`${env.id}\0${pathIdentity(path)}`);
		try {
			keys.add(
				`${env.id}\0${pathIdentity(await canonical(env, path, context))}`,
			);
		} catch (error) {
			if (
				context.abortSignal?.aborted ||
				(error instanceof Error && "code" in error && error.code === "aborted")
			)
				throw error;
			// Lock discovery must not preflight away earlier file actions. An unavailable
			// canonical capability falls back explicitly to lexical ownership, not host IO.
			warnings.push(
				`Canonical-path locking unavailable for ${path}: ${error instanceof Error ? error.message : String(error)}. Serialized by resolved path only`,
			);
		}
	}
	// Reserve the complete set without awaiting. Multi-file patches cannot deadlock or interleave.
	const previous = Promise.all(
		[...keys].map((key) => tails.get(key) ?? Promise.resolve()),
	).then(() => {});
	let release: () => void = () => {};
	const done = new Promise<void>((resolve) => {
		release = resolve;
	});
	const tail = previous.then(() => done);
	for (const key of keys) tails.set(key, tail);
	try {
		await awaitWithContext(previous, context);
		if (context.abortSignal?.aborted) throw new Error("apply_patch aborted");
		return await run();
	} finally {
		release();
		// Keep an aborted waiter chained until its predecessor releases ownership.
		void tail.then(() => {
			for (const key of keys) if (tails.get(key) === tail) tails.delete(key);
		});
	}
}
