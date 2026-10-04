import { posix, win32 } from "node:path";
import type { Context } from "@earendil-works/chord";
import {
	type FileError,
	type FileInfo,
	type FileSystem,
	getOrThrow,
	type Result,
} from "@earendil-works/pi-durable/env";

/** Path policy is lexical only. Every filesystem operation stays in the supplied namespace. */
export class SkillFiles {
	readonly env: FileSystem;
	readonly context: Context;
	constructor(env: FileSystem, context: Context) {
		this.env = env;
		this.context = context;
	}

	check(): void {
		this.context.abortSignal?.throwIfAborted();
	}
	unwrap<T>(result: Result<T, FileError>): T {
		this.check();
		return getOrThrow(result);
	}
	async absolute(path: string): Promise<string> {
		this.check();
		return this.unwrap(await this.env.absolutePath(path, this.context));
	}
	async join(...parts: string[]): Promise<string> {
		this.check();
		return this.unwrap(await this.env.joinPath(parts, this.context));
	}
	async text(path: string): Promise<string> {
		this.check();
		return this.unwrap(await this.env.readTextFile(path, this.context));
	}
	async exists(path: string): Promise<boolean> {
		this.check();
		return this.unwrap(await this.env.exists(path, this.context));
	}
	async canonical(path: string): Promise<string> {
		this.check();
		return this.unwrap(await this.env.canonicalPath(path, this.context));
	}
	async entries(path: string): Promise<FileInfo[]> {
		this.check();
		return this.unwrap(await this.env.listDir(path, this.context))
			.sort((a, b) => a.name.localeCompare(b.name))
			.filter((entry) => !entry.name.startsWith("."));
	}
	async kind(
		entry: FileInfo,
		path: string,
	): Promise<"file" | "directory" | undefined> {
		if (entry.kind !== "symlink") return entry.kind;
		const canonical = await this.optionalCanonical(path);
		if (!canonical) return undefined;
		const result = await this.env.fileInfo(canonical, this.context);
		this.check();
		if (!result.ok) {
			if (
				result.error.code === "not_found" ||
				result.error.code === "not_directory"
			)
				return undefined;
			throw result.error;
		}
		return result.value.kind === "symlink" ? undefined : result.value.kind;
	}
	async optionalCanonical(path: string): Promise<string | undefined> {
		this.check();
		const result = await this.env.canonicalPath(path, this.context);
		this.check();
		if (result.ok) return result.value;
		if (
			result.error.code === "not_found" ||
			result.error.code === "not_directory"
		)
			return undefined;
		throw result.error;
	}
}

function pathStyle(path: string) {
	return /^[A-Za-z]:[\\/]|^\\\\/.test(path) ? win32 : posix;
}
export function isAbsolute(path: string): boolean {
	return posix.isAbsolute(path) || win32.isAbsolute(path);
}
export function relative(root: string, path: string): string {
	return pathStyle(root).relative(root, path).replaceAll("\\", "/");
}
export function isWithin(root: string, path: string): boolean {
	const child = relative(root, path);
	return (
		child === "" ||
		(child !== ".." && !child.startsWith("../") && !isAbsolute(child))
	);
}
