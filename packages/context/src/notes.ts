// Adapted from pi-codex-conversion, Copyright (c) 2026 Igor Warzocha, MIT.

import {
	type ConversationId,
	defineTool,
	type JsonObject,
	type Storage,
	type Tx,
} from "@earendil-works/pi-durable";
import { canReadContextTarget } from "../../../internal/context-visibility.ts";
import { normalizeFilePath, normalizePrefix } from "./note-path.ts";
import {
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
	contextHelpText,
	contextOutputLimits,
	contextToolHelp,
	type NotesArguments,
	normalizeNotesArguments,
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
		description: "Persistent notes",
		parameters: notesParameters,
		prepareArguments: prepareNotesArguments,
		replay: "safe",
		outputLimits: contextOutputLimits,
		async execute(args = {}, api, context) {
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
			if (help)
				return {
					output: [{ type: "text", text: contextHelpText(help) }],
					details: help,
				};
			args = normalizeNotesArguments(args);
			validateNotesArguments(args);
			context.abortSignal?.throwIfAborted();
			const { target } = await resolveContextTarget(
				options.remote,
				args,
				api.conversationId,
				context,
			);
			const writing =
				args.action === "append_to_file" || args.action === "write_file";
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
				.commit(async (tx): Promise<JsonObject> => {
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
							append: args.action === "append_to_file",
							now: options.now,
						});
						return { file: { path: file.path } };
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
			return {
				output: [{ type: "text", text: JSON.stringify(result) }],
				details: result,
			};
		},
	});
	return { ...tool, executionHints: { discovery: "help" as const } };
}

async function readNotes(
	tx: Tx,
	id: ConversationId,
	args: NotesArguments,
	hasCatalog: boolean,
): Promise<JsonObject> {
	const state = hasCatalog ? await tx.doc(NotesState, id) : { files: [] };
	if (args.action === "read_file") {
		const path = normalizeFilePath(args.path);
		const file = state.files.find((file) => file.path === path);
		if (!file) return { source: "sqlite", file: null };
		const lines = (await readNoteText(tx, id, path)).split("\n");
		const start = lineIndex(args.start_line, lines.length, 0);
		const stop = lineIndex(args.stop_line, lines.length, lines.length - 1);
		return {
			source: "sqlite",
			file: {
				...noteMetadata(file),
				content: start <= stop ? lines.slice(start, stop + 1).join("\n") : "",
				start_line: start + 1,
				stop_line: Math.max(start, stop) + 1,
				total_lines: lines.length,
			},
		};
	}
	if (args.action === "list_files_by_prefix") {
		const prefix = normalizePrefix(args.prefix);
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
			})
			.slice(0, boundedInteger(args.max_results, 20, 100))
			.map(noteMetadata);
		return { source: "sqlite", files };
	}
	const query = requiredString(
		args.query,
		"notes search_contents requires query",
	);
	const prefix = normalizePrefix(args.path_prefix);
	const fileLimit = boundedInteger(args.max_files, 20, 100);
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
			if (line.includes(query)) matches.push({ line_number: index + 1, line });
			if (matches.length >= matchLimit) break;
		}
		if (!matches.length) continue;
		files.push({ path: file.path, matches });
		if (files.length >= fileLimit) break;
	}
	return { source: "sqlite", files };
}

function lineIndex(value: unknown, count: number, fallback: number): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value === 0)
		return fallback;
	const index = value > 0 ? value - 1 : count + value;
	return Math.max(0, Math.min(index, Math.max(0, count - 1)));
}
