import { gunzipSync } from "node:zlib";
import { parseJson } from "./registry.ts";

const decoder = new TextDecoder("utf-8", { fatal: true });

function text(bytes: Uint8Array): string {
	const end = bytes.indexOf(0);
	if (end !== -1 && bytes.subarray(end).some((byte) => byte !== 0))
		throw new Error("Invalid tar string padding");
	return decoder.decode(end === -1 ? bytes : bytes.subarray(0, end));
}

function octal(bytes: Uint8Array): number {
	const value = decoder
		.decode(bytes)
		.replace(/[\0 ]+$/, "")
		.trim();
	if (!/^[0-7]+$/.test(value)) throw new Error("Invalid tar numeric field");
	const result = Number.parseInt(value, 8);
	if (!Number.isSafeInteger(result))
		throw new Error("Tar numeric field overflow");
	return result;
}

function safePath(path: string): string {
	const normalized = path.endsWith("/") ? path.slice(0, -1) : path;
	if (
		!normalized ||
		normalized.includes("\\") ||
		/[\x00-\x1f\x7f]/.test(normalized) ||
		normalized
			.split("/")
			.some((part) => !part || part === "." || part === "..") ||
		normalized.includes(":")
	)
		throw new Error("Unsafe tar entry path");
	return normalized;
}

/** Local PAX only. No global state, link targets, sparse files or GNU overrides. */
function pax(bytes: Uint8Array): Map<string, string> {
	const fields = new Map<string, string>();
	let offset = 0;
	while (offset < bytes.length) {
		const space = bytes.indexOf(32, offset);
		if (space === -1) throw new Error("Invalid PAX record length");
		const digits = decoder.decode(bytes.subarray(offset, space));
		if (!/^[1-9][0-9]*$/.test(digits))
			throw new Error("Invalid PAX record length");
		const length = Number(digits);
		const end = offset + length;
		if (
			!Number.isSafeInteger(end) ||
			end > bytes.length ||
			end <= space + 1 ||
			bytes[end - 1] !== 10
		)
			throw new Error("Truncated PAX record");
		const record = decoder.decode(bytes.subarray(space + 1, end - 1));
		const equals = record.indexOf("=");
		if (equals < 1) throw new Error("Invalid PAX key/value");
		const key = record.slice(0, equals);
		if (fields.has(key)) throw new Error("Duplicate PAX key");
		if (
			![
				"path",
				"size",
				"mtime",
				"atime",
				"ctime",
				"uid",
				"gid",
				"uname",
				"gname",
				"comment",
				"charset",
			].includes(key)
		)
			throw new Error(`Unsupported PAX field: ${key}`);
		fields.set(key, record.slice(equals + 1));
		offset = end;
	}
	return fields;
}

/** Inspect bytes only: no paths are created and no archive entry is executed. */
export function archivePackageJson(
	archive: Uint8Array,
	maxExpandedBytes: number,
	signal?: AbortSignal,
): unknown {
	signal?.throwIfAborted();
	const tar = gunzipSync(archive, { maxOutputLength: maxExpandedBytes });
	signal?.throwIfAborted();
	let offset = 0;
	let local: Map<string, string> | undefined;
	let manifest: Uint8Array | undefined;
	const paths = new Set<string>();
	const files = new Set<string>();
	const directories = new Set<string>();
	while (offset + 512 <= tar.length) {
		signal?.throwIfAborted();
		const header = tar.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) {
			if (
				local ||
				offset + 1024 > tar.length ||
				tar.subarray(offset).some((byte) => byte !== 0)
			)
				throw new Error("Invalid tar end marker or trailing data");
			if (!manifest) throw new Error("Archive has no package/package.json");
			return parseJson(manifest);
		}
		const checksum = octal(header.subarray(148, 156));
		const actual = header.reduce(
			(sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
			0,
		);
		if (checksum !== actual) throw new Error("Invalid tar header checksum");
		const magic = text(header.subarray(257, 263));
		if (magic !== "ustar" && magic !== "ustar ")
			throw new Error("Unsupported tar format");
		const prefix = text(header.subarray(345, 500));
		const name = text(header.subarray(0, 100));
		const headerPath = safePath(prefix ? `${prefix}/${name}` : name);
		const type = header[156];
		if (type !== 0 && type !== 48 && type !== 53 && type !== 120)
			throw new Error(
				"Unsupported tar entry (links and global/GNU extensions are forbidden)",
			);
		if (header.subarray(157, 257).some((byte) => byte !== 0))
			throw new Error("Unexpected tar link target");
		let size = octal(header.subarray(124, 136));
		if (type !== 120 && local?.has("size")) {
			const value = local.get("size") ?? "";
			if (
				!/^(0|[1-9][0-9]*)$/.test(value) ||
				!Number.isSafeInteger(Number(value))
			)
				throw new Error("Invalid PAX size");
			size = Number(value);
		}
		const start = offset + 512;
		const end = start + size;
		const next = start + Math.ceil(size / 512) * 512;
		if (!Number.isSafeInteger(next) || next > tar.length)
			throw new Error("Truncated tar entry");
		if (tar.subarray(end, next).some((byte) => byte !== 0))
			throw new Error("Invalid tar entry padding");
		const data = tar.subarray(start, end);
		if (type === 120) {
			if (local || size > 1024 * 1024)
				throw new Error("Invalid or oversized local PAX header");
			local = pax(data);
		} else {
			const path = safePath(local?.get("path") ?? headerPath);
			local = undefined;
			if (path !== "package" && !path.startsWith("package/"))
				throw new Error("Archive entry is outside package/");
			if (paths.has(path)) throw new Error(`Duplicate tar path: ${path}`);
			paths.add(path);
			for (
				let slash = path.indexOf("/");
				slash !== -1;
				slash = path.indexOf("/", slash + 1)
			) {
				const parent = path.slice(0, slash);
				if (files.has(parent)) throw new Error("Tar path traverses a file");
				directories.add(parent);
			}
			if (type === 53) {
				if (size !== 0) throw new Error("Tar directory has file content");
				directories.add(path);
			} else {
				if (directories.has(path))
					throw new Error("Tar file conflicts with a directory");
				files.add(path);
				if (path === "package")
					throw new Error("Package root must be a directory");
				if (path === "package/package.json") {
					if (size > 2 * 1024 * 1024)
						throw new Error("Package JSON exceeds 2 MiB");
					manifest = data;
				}
			}
		}
		offset = next;
	}
	throw new Error("Truncated tar archive: missing end marker");
}
