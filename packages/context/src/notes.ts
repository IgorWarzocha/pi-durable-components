// Adapted from pi-codex-conversion, Copyright (c) 2026 Igor Warzocha, MIT.

import {
	type ConversationId,
	defineTool,
	type JsonObject,
	type Storage,
	type Tx,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { canReadContextTarget } from "../../../internal/context-visibility.ts";
import { normalizeFilePath, normalizePrefix } from "./note-path.ts";
import {
	beginNoteWrite,
	mutateNote,
	NotesState,
	noteMetadata,
	readNoteText,
} from "./note-store.ts";
import {
	type ContextRemoteCatalog,
	remoteContextHelp,
	resolveContextTarget,
} from "./remote.ts";
import {
	boundedInteger,
	contextOutputLimits,
	contextTextSlice,
	contextToolHelp,
	contextToolResult,
	type NotesArguments,
	notesParameters,
	prepareNotesArguments,
	requiredString,
	validateNotesArguments,
} from "./tool-contract.ts";

export function createNotesTool(options: {
	now: () => number;
	storage: () => Storage;
	remote?: ContextRemoteCatalog | undefined;
}) {
	const tool = defineTool({
		name: "notes",
		description:
			"Persistent notes for handing off task state between context windows",
		parameters: notesParameters,
		structuredOutputSchema: Type.Object({}, { additionalProperties: true }),
		prepareArguments: prepareNotesArguments,
		replay: "safe",
		outputLimits: contextOutputLimits,
		async execute(args = {}, api, context) {
			const writing = args.action === "append" || args.action === "write";
			if (writing)
				await api.commit(
					(tx) => beginNoteWrite(tx, api.conversationId, api.taskId),
					context,
				);
			let help = contextToolHelp("notes", args);
			if (help)
				help = {
					...help,
					...(await remoteContextHelp(
						options.remote,
						api.conversationId,
						options.storage(),
						context,
					)),
				};
			if (help) {
				return contextToolResult(help);
			}
			validateNotesArguments(args);
			context.abortSignal?.throwIfAborted();
			const { target } = await resolveContextTarget(
				options.remote,
				args,
				api.conversationId,
				context,
			);
			if (writing && target !== api.conversationId)
				throw new Error("Notes writes may only target the caller conversation");
			if (
				!writing &&
				target !== api.conversationId &&
				!(await canReadContextTarget(
					options.storage(),
					api.conversationId,
					target,
					context,
				))
			)
				throw new Error("This conversation's context is not visible here");
			// tx.doc creates missing documents, even for reads. An absent catalog is
			// an empty snapshot, not permission to initialize a foreign conversation.
			const hasCatalog =
				writing ||
				(await api.snapshot(NotesState, target, context)) !== undefined;
			const result = await api
				.commit(async (tx) => {
					if (!(await tx.conversation(target)))
						throw new Error(`Conversation ${target} does not exist`);
					if (writing) {
						const file = await mutateNote(tx, {
							conversationId: api.conversationId,
							taskId: api.taskId,
							path: normalizeFilePath(args.path),
							text: requiredString(
								args.text,
								`notes ${args.action} requires text`,
								true,
							),
							append: args.action === "append",
							now: options.now,
						});
						// A saved note must have a deliverable acknowledgement in the same commit.
						return contextToolResult({ file: { path: file.path } });
					}
					return readNotes(tx, target, args, hasCatalog);
				}, context)
				.catch((error: unknown) => {
					if (writing && options.remote && context.abortSignal?.aborted)
						throw new Error(
							"Notes write was interrupted after dispatch; its outcome is uncertain. Read the note before another write",
							{ cause: error },
						);
					throw error;
				});
			return result;
		},
	});
	return { ...tool, executionHints: { discovery: "help" as const } };
}

async function readNotes(
	tx: Tx,
	id: ConversationId,
	args: NotesArguments,
	hasCatalog: boolean,
): Promise<ReturnType<typeof contextToolResult>> {
	const state = hasCatalog ? await tx.doc(NotesState, id) : { files: [] };
	if (args.action === "read") {
		const path = normalizeFilePath(args.path);
		const file = state.files.find((file) => file.path === path);
		if (!file) return contextToolResult({ file: null });
		const lines = (await readNoteText(tx, id, path)).split("\n");
		const start = lineIndex(args.start_line, lines.length, 0);
		const stop = lineIndex(args.stop_line, lines.length, lines.length - 1);
		const selected =
			start <= stop ? lines.slice(start, stop + 1).join("\n") : "";
		const offset = boundedInteger(args.offset_chars, 0, selected.length, 0);
		const limit = boundedInteger(
			args.limit_chars,
			selected.length,
			selected.length,
			0,
		);
		const content = contextTextSlice(selected, offset, limit);
		const nextOffset = offset + content.length;
		const detail = {
			path: file.path,
			content,
			total_chars: selected.length,
			...(nextOffset < selected.length
				? { next_offset_chars: nextOffset }
				: {}),
			start_line: start + 1,
			stop_line: Math.max(start, stop) + 1,
			total_lines: lines.length,
		};
		return contextToolResult(
			{ file: detail },
			{ file: { ...noteMetadata(file), ...detail } },
		);
	}
	if (args.action === "list") {
		const prefix = normalizePrefix(args.path);
		const direction = args.file_order === "descending" ? -1 : 1;
		const files = state.files
			.filter((file) => file.path.startsWith(prefix))
			.sort((left, right) => {
				const compared =
					args.file_order_by === "created_at"
						? left.createdAt - right.createdAt
						: args.file_order_by === "updated_at"
							? left.updatedAt - right.updatedAt
							: left.path.localeCompare(right.path);
				return compared * direction;
			});
		const limit = boundedInteger(args.limit, 20, 100);
		const selected = files.slice(0, limit);
		const truncated = files.length > limit ? { truncated: true } : {};
		return contextToolResult(
			{
				files: selected.map((file) => ({
					path: file.path,
					updated_at: new Date(file.updatedAt).toISOString(),
					...(args.file_order_by === "created_at"
						? { created_at: new Date(file.createdAt).toISOString() }
						: {}),
				})),
				...truncated,
			},
			{ files: selected.map(noteMetadata), ...truncated },
		);
	}
	const query = requiredString(args.query, "notes search requires query");
	const prefix = normalizePrefix(args.path);
	const fileLimit = boundedInteger(args.limit, 20, 100);
	const matchLimit = boundedInteger(args.max_matches_per_file, 20, 100);
	const candidates = state.files
		.filter((file) => file.path.startsWith(prefix))
		.sort((left, right) =>
			args.recent_file_first === true
				? right.createdAt - left.createdAt
				: left.path.localeCompare(right.path),
		);
	const files: JsonObject[] = [];
	for (const file of candidates) {
		const matches: JsonObject[] = [];
		const lines = (await readNoteText(tx, id, file.path)).split("\n");
		for (const [index, line] of lines.entries()) {
			if (line.includes(query))
				matches.push({
					line_number: index + 1,
					line,
				});
			if (matches.length > matchLimit) break;
		}
		if (!matches.length) continue;
		if (files.length === fileLimit)
			return contextToolResult({ files, truncated: true });
		files.push({
			path: file.path,
			matches: matches.slice(0, matchLimit),
			...(matches.length > matchLimit ? { truncated: true } : {}),
		});
	}
	return contextToolResult({ files });
}

function lineIndex(value: unknown, count: number, fallback: number): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value === 0)
		return fallback;
	const index = value > 0 ? value - 1 : count + value;
	return Math.max(0, Math.min(index, Math.max(0, count - 1)));
}
