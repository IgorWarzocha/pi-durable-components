// Derived from Codex lib.rs and pi-codex-conversion's executor.ts. See ../NOTICE.
import type { Context } from "@earendil-works/chord";
import {
	type ExecutionEnv,
	err,
	FileError,
	getOrThrow,
	ok,
	type Result,
} from "@earendil-works/pi-durable/env";

export function checkAbort(context: Context): void {
	if (context.abortSignal?.aborted)
		throw new Error(
			"apply_patch aborted. An interrupted mutation may have taken effect; read its target before retrying",
		);
}

async function readText(
	env: ExecutionEnv,
	path: string,
	context: Context,
): Promise<Result<string, FileError>> {
	const bytes = await env.readBinaryFile(path, context);
	if (!bytes.ok) return bytes;
	try {
		return ok(
			new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
				bytes.value,
			),
		);
	} catch {
		return err(
			new FileError("invalid", "stream did not contain valid UTF-8", path),
		);
	}
}

/** Environment-only mutations and the accuracy of their recoverable contents. */
export class PatchFileMutations {
	private accuracy = true;
	private readonly env: ExecutionEnv;
	private readonly context: Context;
	constructor(env: ExecutionEnv, context: Context) {
		this.env = env;
		this.context = context;
	}
	get exact(): boolean {
		return this.accuracy;
	}
	markUncertain(): void {
		this.accuracy = false;
	}

	read(path: string): Promise<Result<string, FileError>> {
		return readText(this.env, path, this.context);
	}

	async noteSupport(path: string): Promise<void> {
		const info = await this.env.fileInfo(path, this.context);
		// The native metadata adapter follows symlinks, while Durable fileInfo uses lstat.
		// A dangling link reports NotFound there, not an existing unsupported delta target.
		if (info.ok && info.value.kind === "symlink") {
			const target = await this.env.canonicalPath(path, this.context);
			if (!target.ok && target.error.code === "not_found") return;
		}
		if (info.ok ? info.value.kind !== "file" : info.error.code !== "not_found")
			this.markUncertain();
	}
	async optionalRead(path: string): Promise<string | null> {
		await this.noteSupport(path);
		const read = await this.read(path);
		if (read.ok) return read.value;
		if (read.error.code !== "not_found") this.markUncertain();
		return null;
	}
	async write(
		path: string,
		contents: string,
		allowParents: boolean,
	): Promise<void> {
		checkAbort(this.context);
		let result = await this.env.writeFile(path, contents, this.context);
		if (
			!result.ok &&
			result.error.code === "not_found" &&
			allowParents &&
			!this.context.abortSignal?.aborted
		) {
			// Only retry the native engine's explicit missing-parent case, not interrupted writes.
			const parent = getOrThrow(
				await this.env.joinPath([path, ".."], this.context),
			);
			const created = await this.env.createDir(
				parent,
				{ recursive: true },
				this.context,
			);
			if (!created.ok) {
				this.markUncertain();
				throw new Error(
					`Failed to create parent directories for ${path}: ${created.error.message}`,
				);
			}
			checkAbort(this.context);
			result = await this.env.writeFile(path, contents, this.context);
		}
		if (!result.ok) {
			this.markUncertain();
			throw new Error(`Failed to write file ${path}: ${result.error.message}`);
		}
		// No post-write abort check here. The caller must first record this committed write.
	}
	async remove(
		path: string,
		oldContent: string | null,
		label: string,
	): Promise<void> {
		checkAbort(this.context);
		let info = await this.env.fileInfo(path, this.context);
		if (info.ok && info.value.kind === "symlink") {
			const canonical = await this.env.canonicalPath(path, this.context);
			if (!canonical.ok)
				throw new Error(`${label} ${path}: ${canonical.error.message}`);
			info = await this.env.fileInfo(canonical.value, this.context);
		}
		if (!info.ok) throw new Error(`${label} ${path}: ${info.error.message}`);
		if (info.value.kind === "directory")
			throw new Error(`${label} ${path}: path is a directory`);
		checkAbort(this.context);
		const removed = await this.env.remove(
			path,
			{ recursive: false, force: false },
			this.context,
		);
		if (!removed.ok) {
			const after = await this.read(path);
			if (!(oldContent !== null && after.ok && after.value === oldContent))
				this.markUncertain();
			throw new Error(`${label} ${path}: ${removed.error.message}`);
		}
	}
}
