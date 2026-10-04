// Derived from Codex file_update.rs, text_file.rs, and seek_sequence.rs. See ../NOTICE.
import { type Chunk, trimRust } from "./parser.ts";

function normalize(text: string): string {
	return trimRust(text)
		.replace(/[\u2010-\u2015\u2212]/g, "-")
		.replace(/[\u2018-\u201b]/g, "'")
		.replace(/[\u201c-\u201f]/g, '"')
		.replace(/[\u00a0\u2002-\u200a\u202f\u205f\u3000]/g, " ");
}

function seekSequence(
	lines: string[],
	pattern: string[],
	start: number,
	eof: boolean,
): number | undefined {
	if (pattern.length === 0) return start;
	if (pattern.length > lines.length) return undefined;
	const limit = lines.length - pattern.length;
	const searchStart = eof ? Math.max(limit, start) : start;
	const tiers = [
		(text: string) => text,
		(text: string) => trimRust(text, true),
		trimRust,
		normalize,
	];
	for (const transform of tiers) {
		for (let index = searchStart; index <= limit; index++) {
			if (
				pattern.every(
					(text, offset) =>
						transform(lines[index + offset]!) === transform(text),
				)
			)
				return index;
		}
	}
	return undefined;
}

type Replacement = { start: number; oldLength: number; newLines: string[] };
function computeReplacements(
	lines: string[],
	path: string,
	chunks: Chunk[],
): Replacement[] {
	const replacements: Replacement[] = [];
	let lineIndex = 0;
	for (const chunk of chunks) {
		if (chunk.context !== undefined) {
			const index = seekSequence(lines, [chunk.context], lineIndex, false);
			if (index === undefined)
				throw new Error(`Failed to find context '${chunk.context}' in ${path}`);
			lineIndex = index + 1;
		}
		if (chunk.oldLines.length === 0) {
			replacements.push({
				start: lines.length,
				oldLength: 0,
				newLines: chunk.newLines,
			});
			continue;
		}
		let pattern = chunk.oldLines;
		let newLines = chunk.newLines;
		let found = seekSequence(lines, pattern, lineIndex, chunk.eof);
		if (found === undefined && pattern.at(-1) === "") {
			pattern = pattern.slice(0, -1);
			if (newLines.at(-1) === "") newLines = newLines.slice(0, -1);
			found = seekSequence(lines, pattern, lineIndex, chunk.eof);
		}
		if (found === undefined)
			throw new Error(
				`Failed to find expected lines in ${path}:\n${chunk.oldLines.join("\n")}`,
			);
		let oldStart = 0;
		let newStart = 0;
		for (const context of chunk.contextLines) {
			if (context.old >= pattern.length || context.new >= newLines.length)
				break;
			if (oldStart !== context.old || newStart !== context.new) {
				replacements.push({
					start: found + oldStart,
					oldLength: context.old - oldStart,
					newLines: newLines.slice(newStart, context.new),
				});
			}
			oldStart = context.old + 1;
			newStart = context.new + 1;
		}
		if (oldStart !== pattern.length || newStart !== newLines.length) {
			replacements.push({
				start: found + oldStart,
				oldLength: pattern.length - oldStart,
				newLines: newLines.slice(newStart),
			});
		}
		lineIndex = found + pattern.length;
	}
	return replacements.sort((a, b) => a.start - b.start);
}

export function updateContents(
	contents: string,
	path: string,
	chunks: Chunk[],
): string {
	const lines: { text: string; ending: string | undefined }[] = [];
	let preferredEnding: string | undefined;
	let cursor = 0;
	for (const match of contents.matchAll(/\r\n|\r|\n/g)) {
		preferredEnding ??= match[0];
		lines.push({ text: contents.slice(cursor, match.index), ending: match[0] });
		cursor = match.index + match[0].length;
	}
	if (cursor < contents.length)
		lines.push({ text: contents.slice(cursor), ending: undefined });
	preferredEnding ??= "\n";
	const replacements = computeReplacements(
		lines.map((line) => line.text),
		path,
		chunks,
	);
	const output: typeof lines = [];
	let sourceIndex = 0;
	for (const replacement of replacements) {
		// SourceFile's consuming iterator defines ordering, including equal-index insertions.
		const unchanged = Math.max(0, replacement.start - sourceIndex);
		for (const line of lines.slice(sourceIndex, sourceIndex + unchanged))
			output.push(line);
		sourceIndex += unchanged + replacement.oldLength;
		for (const text of replacement.newLines)
			output.push({ text, ending: preferredEnding });
	}
	for (const line of lines.slice(sourceIndex)) output.push(line);
	// The native helper always terminates resulting lines, even if the input did not.
	return output
		.map((line) => line.text + (line.ending ?? preferredEnding))
		.join("");
}
