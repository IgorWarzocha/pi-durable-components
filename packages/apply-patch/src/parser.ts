// TypeScript translation of OpenAI Codex's parser.rs and streaming_parser.rs.
// Source revisions and license notices are recorded in ../NOTICE.
export type Chunk = {
	context: string | undefined;
	oldLines: string[];
	newLines: string[];
	contextLines: { old: number; new: number }[];
	eof: boolean;
};
export type Action =
	| { type: "add"; path: string; contents: string }
	| { type: "delete"; path: string }
	| {
			type: "update";
			path: string;
			movePath: string | undefined;
			chunks: Chunk[];
			line: number;
	  };
export type ParsedPatch = {
	actions: Action[];
	environmentId: string | undefined;
};
const headers = [
	["*** Add File: ", "add"],
	["*** Delete File: ", "delete"],
	["*** Update File: ", "update"],
] as const;

// Rust str::trim uses Unicode White_Space, which excludes JavaScript's BOM.
export function trimRust(text: string, endOnly = false): string {
	return text.replace(
		endOnly ? /\p{White_Space}+$/u : /^\p{White_Space}+|\p{White_Space}+$/gu,
		"",
	);
}

function invalidPatch(message: string): never {
	throw new Error(`invalid patch: ${message}`);
}
function invalidHunk(line: number, message: string): never {
	throw new Error(`invalid hunk at line ${line}, ${message}`);
}
function unexpected(line: number, text: string): never {
	return invalidHunk(
		line,
		`Unexpected line found in update hunk: '${text}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
	);
}
function emptyChunk(chunk: Chunk | undefined): boolean {
	return (
		chunk !== undefined &&
		chunk.oldLines.length === 0 &&
		chunk.newLines.length === 0
	);
}
function ensureUpdate(
	action: Action | undefined,
	line: number,
	text: string,
): void {
	if (action?.type !== "update") return;
	if (action.chunks.length === 0)
		invalidHunk(
			action.line,
			`Update file hunk for path '${action.path}' is empty`,
		);
	if (emptyChunk(action.chunks.at(-1))) {
		if (text === "*** End Patch")
			invalidHunk(line, "Update hunk does not contain any lines");
		unexpected(line, text);
	}
}
function boundaries(lines: string[]): string | undefined {
	if (trimRust(lines[0] ?? "") !== "*** Begin Patch") {
		return lines.length === 0
			? "The last line of the patch must be '*** End Patch'"
			: "The first line of the patch must be '*** Begin Patch'";
	}
	if (trimRust(lines.at(-1) ?? "") !== "*** End Patch")
		return "The last line of the patch must be '*** End Patch'";
	return undefined;
}

export function parsePatch(input: string): ParsedPatch {
	const text = trimRust(input);
	let lines =
		text === ""
			? []
			: text
					.split("\n")
					.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
	let boundaryError = boundaries(lines);
	if (boundaryError !== undefined) {
		if (
			lines.length >= 4 &&
			["<<EOF", "<<'EOF'", '<<"EOF"'].includes(lines[0] ?? "") &&
			lines.at(-1)?.endsWith("EOF")
		) {
			lines = lines.slice(1, -1);
			boundaryError = boundaries(lines);
		}
		if (boundaryError !== undefined) invalidPatch(boundaryError);
	}
	const actions: Action[] = [];
	let environmentId: string | undefined;
	let ended = false;
	for (let index = 1; index < lines.length; index++) {
		// push_delta strips one CR again after parse_patch's str::lines + join.
		let original = lines[index]!;
		if (index < lines.length - 1 && original.endsWith("\r"))
			original = original.slice(0, -1);
		const line = index + 1;
		const action = actions.at(-1);
		const trimmed = trimRust(original);
		const marker =
			action?.type === "update" ? trimRust(original, true) : trimmed;
		// finish() checks the last buffered marker before consulting the streaming mode.
		if (index === lines.length - 1 && trimmed === "*** End Patch") {
			ensureUpdate(action, line, "*** End Patch");
			ended = true;
			continue;
		}
		if (ended) {
			if (trimmed !== "")
				invalidPatch("The last line of the patch must be '*** End Patch'");
			continue;
		}
		if (marker === "*** End Patch") {
			ensureUpdate(action, line, "*** End Patch");
			ended = true;
			continue;
		}
		if (action === undefined && marker.startsWith("*** Environment ID:")) {
			if (environmentId !== undefined)
				invalidPatch(
					"apply_patch environment_id cannot be specified more than once",
				);
			environmentId = trimRust(marker.slice("*** Environment ID:".length));
			if (!environmentId)
				invalidPatch("apply_patch environment_id cannot be empty");
			continue;
		}
		let headerFound = false;
		for (const [prefix, type] of headers) {
			if (!marker.startsWith(prefix)) continue;
			ensureUpdate(action, line, marker);
			const path = marker.slice(prefix.length);
			if (type === "add") actions.push({ type, path, contents: "" });
			else if (type === "delete") actions.push({ type, path });
			else actions.push({ type, path, movePath: undefined, chunks: [], line });
			headerFound = true;
			break;
		}
		if (headerFound) continue;
		if (action?.type === "add" && original.startsWith("+")) {
			action.contents += original.slice(1) + "\n";
			continue;
		}
		if (action?.type !== "update") {
			invalidHunk(
				line,
				`'${trimmed}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
			);
		}
		let chunk = action.chunks.at(-1);
		const isContextMarker = marker === "@@" || marker.startsWith("@@ ");
		if (chunk?.eof) {
			if (marker === "") continue;
			if (!isContextMarker)
				invalidHunk(
					line,
					`Expected update hunk to start with a @@ context marker, got: '${original}'`,
				);
		}
		if (
			action.chunks.length === 0 &&
			action.movePath === undefined &&
			marker.startsWith("*** Move to: ")
		) {
			action.movePath = marker.slice("*** Move to: ".length);
			continue;
		}
		if (isContextMarker) {
			if (emptyChunk(chunk)) unexpected(line, original);
			action.chunks.push({
				context: marker.startsWith("@@ ") ? marker.slice(3) : undefined,
				oldLines: [],
				newLines: [],
				contextLines: [],
				eof: false,
			});
			continue;
		}
		if (marker === "*** End of File") {
			if (emptyChunk(chunk))
				invalidHunk(line, "Update hunk does not contain any lines");
			if (chunk !== undefined) chunk.eof = true;
			continue;
		}
		if (original === "" || /^[ +\-]/.test(original)) {
			if (chunk === undefined) {
				chunk = {
					context: undefined,
					oldLines: [],
					newLines: [],
					contextLines: [],
					eof: false,
				};
				action.chunks.push(chunk);
			}
			const value = original.slice(1);
			if (original === "" || original.startsWith(" ")) {
				chunk.contextLines.push({
					old: chunk.oldLines.length,
					new: chunk.newLines.length,
				});
				chunk.oldLines.push(value);
				chunk.newLines.push(value);
			} else if (original.startsWith("+")) chunk.newLines.push(value);
			else chunk.oldLines.push(value);
			continue;
		}
		if (chunk !== undefined && !emptyChunk(chunk))
			invalidHunk(
				line,
				`Expected update hunk to start with a @@ context marker, got: '${original}'`,
			);
		unexpected(line, original);
	}
	if (!ended)
		invalidPatch("The last line of the patch must be '*** End Patch'");
	return { actions, environmentId };
}

/** The pinned TS executor's pre-parse guard also rejects duplicate sources in empty update hunks. */
export function sourcePathsForDuplicateGuard(
	input: string,
): string[] | undefined {
	const text = trimRust(input);
	if (!text) return undefined;
	let lines = text
		.split("\n")
		.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
	if (boundaries(lines) !== undefined) {
		if (
			lines.length < 4 ||
			!["<<EOF", "<<'EOF'", '<<"EOF"'].includes(lines[0] ?? "") ||
			!lines.at(-1)?.endsWith("EOF")
		)
			return undefined;
		lines = lines.slice(1, -1);
		if (boundaries(lines) !== undefined) return undefined;
	}
	const paths: string[] = [];
	let section: "started" | Action["type"] = "started";
	let sawEnvironment = false;
	for (let index = 1; index < lines.length - 1; index++) {
		const original = lines[index]!;
		const line = trimRust(original, section === "update");
		if (line === "*** End Patch") return undefined;
		const header = headers.find(([prefix]) => line.startsWith(prefix));
		if (header !== undefined) {
			const path = line.slice(header[0].length);
			if (!path) return undefined;
			paths.push(path);
			section = header[1];
			continue;
		}
		if (section === "started") {
			if (
				!line.startsWith("*** Environment ID:") ||
				sawEnvironment ||
				!trimRust(line.slice("*** Environment ID:".length))
			)
				return undefined;
			sawEnvironment = true;
		} else if (section === "add") {
			if (!original.startsWith("+")) return undefined;
		} else if (section === "delete") return undefined;
		else if (
			!(
				original === "" ||
				/^[ +\-]/.test(original) ||
				line === "@@" ||
				line.startsWith("@@ ") ||
				line === "*** End of File" ||
				line.startsWith("*** Move to: ")
			)
		)
			return undefined;
	}
	return paths;
}
