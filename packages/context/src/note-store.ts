import type { Context } from "@earendil-works/chord";
import type {
	ConversationId,
	DocumentReader,
	EntryId,
	TaskId,
	Tx,
} from "@earendil-works/pi-durable";
import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable";
import { latestUserEntry, WindowState } from "./window-state.ts";

export type NoteMetadata = {
	path: string;
	bytes: number;
	lines: number;
	createdAt: number;
	updatedAt: number;
};
type NoteFreshness = {
	windowId: string;
	userEntry: EntryId | null;
	taskId: TaskId;
	updatedAt: number;
};
type NotesCatalog = {
	files: NoteMetadata[];
	totalBytes: number;
	lastWrite?: NoteFreshness;
};

/** The sole authority for metadata and freshness. Bodies live in per-path documents. */
export const NotesState = defineDoc<NotesCatalog>({
	kind: "howaboua.context.notes-state",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ files: [], totalBytes: 0 }),
});
const NoteFile = defineDocFamily<{ text: string }, null>({
	kind: "howaboua.context.note-file",
	version: 1,
	family: true,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ text: "" }),
});
const WriteReceipt = defineDoc<{
	file?: NoteMetadata;
}>({
	kind: "howaboua.context.note-write-receipt",
	version: 1,
	scope: "task",
	initial: () => ({}),
});

export async function requireNotesWindow(
	tx: Tx,
	id: ConversationId,
): Promise<string> {
	const state = await tx.doc(WindowState, id);
	if (!state.window)
		throw new Error(
			"Context window is missing; ask the host to run context.bind or context.submit before using context tools",
		);
	return state.window.id;
}

export async function readNoteText(
	tx: Tx,
	id: ConversationId,
	path: string,
): Promise<string> {
	return (await tx.doc(NoteFile, id, path, null)).text;
}

export async function notesAreFresh(
	tx: Tx,
	id: ConversationId,
): Promise<boolean> {
	const userEntry = await latestUserEntry(tx, id);
	const window = await tx.doc(WindowState, id);
	const state = await tx.doc(NotesState, id);
	return (
		window.window !== undefined &&
		state.lastWrite !== undefined &&
		state.lastWrite.windowId === window.window.id &&
		state.lastWrite.userEntry === userEntry
	);
}

/** Receipt, body, catalog and freshness commit together under the original task identity. */
export async function mutateNote(
	tx: Tx,
	input: {
		conversationId: ConversationId;
		taskId: TaskId;
		path: string;
		text: string;
		append: boolean;
		now: () => number;
	},
): Promise<NoteMetadata> {
	const receipt = await tx.doc(WriteReceipt, input.taskId);
	if (receipt.file) return { ...receipt.file };
	const userEntry = await latestUserEntry(tx, input.conversationId);
	const windowId = await requireNotesWindow(tx, input.conversationId);
	const catalog = await tx.doc(NotesState, input.conversationId);
	const index = catalog.files.findIndex((file) => file.path === input.path);
	const previous = catalog.files[index];
	const file = await tx.doc(NoteFile, input.conversationId, input.path, null);
	const text = input.append ? file.text + input.text : input.text;
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes > 1_000_000)
		throw new Error("Note file exceeds the 1,000,000-byte limit");
	const totalBytes = catalog.totalBytes - (previous?.bytes ?? 0) + bytes;
	if (totalBytes > 10_000_000)
		throw new Error("Context notes exceed the 10,000,000-byte limit");
	const updatedAt = input.now();
	const metadata = {
		path: input.path,
		bytes,
		lines: text === "" ? 0 : text.split("\n").length,
		createdAt: previous?.createdAt ?? updatedAt,
		updatedAt,
	};
	const nextCatalog = [...catalog.files];
	if (index < 0) nextCatalog.push(metadata);
	else nextCatalog[index] = metadata;
	// Empty files and long paths must not turn the catalog into an unbounded document.
	if (Buffer.byteLength(JSON.stringify(nextCatalog), "utf8") > 1_000_000)
		throw new Error("Note path catalog exceeds the 1,000,000-byte limit");
	const freshness: NoteFreshness = {
		windowId,
		userEntry,
		taskId: input.taskId,
		updatedAt,
	};
	file.text = text;
	catalog.files = nextCatalog;
	catalog.totalBytes = totalBytes;
	catalog.lastWrite = freshness;
	receipt.file = metadata;
	return metadata;
}

export function noteMetadata(file: NoteMetadata) {
	return {
		path: file.path,
		bytes: file.bytes,
		created_at: new Date(file.createdAt).toISOString(),
		updated_at: new Date(file.updatedAt).toISOString(),
	};
}

/** Bootstrap lists paths, never loads bodies. */
export async function renderNotesThreadHint(
	reader: DocumentReader,
	id: ConversationId,
	context: Context,
	maxBytes = 4_000,
): Promise<string | undefined> {
	const state = await reader.snapshot(NotesState, id, context);
	const files = [...(state?.files ?? [])].sort(
		(left, right) =>
			right.updatedAt - left.updatedAt || left.path.localeCompare(right.path),
	);
	const header = "Recent notes (up to 5, most-recent first):";
	const lines: string[] = [];
	for (const file of files) {
		if (lines.length >= 5) break;
		const line = `- ${file.path} (${file.lines} ${file.lines === 1 ? "line" : "lines"}, ${file.bytes} UTF-8 bytes)`;
		if (
			Buffer.byteLength([header, ...lines, line].join("\n"), "utf8") <=
			Math.min(maxBytes, 4_000)
		)
			lines.push(line);
	}
	return lines.length ? [header, ...lines].join("\n") : undefined;
}
