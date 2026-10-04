// Adapted from pi-codex-conversion at b2006db9def12c373ae48e70044d30f7d6b7e34f, MIT. See ../NOTICE.

import { pathToFileURL } from "node:url";
import { readNotebookJournalCodeCells } from "./journal.ts";
import { OneShotLspProcess } from "./lsp-process.ts";
import {
	boundedDiagnosticResult,
	boundText,
	formatNotebookDiagnostics,
	formatRuntimeHealth,
	parseDiagnosticReport,
} from "./notebook-diagnostic-report.ts";
import type { NotebookControlResult } from "./runtime-contract.ts";
import type { NotebookRuntimeHealthState } from "./runtime-health.ts";

const DIAGNOSTIC_TIMEOUT_MS = 30_000;
const HOST_BINDINGS = new Set([
	"ALL_TOOLS",
	"exit",
	"generatedImage",
	"image",
	"load",
	"notify",
	"store",
	"text",
	"tools",
	"yield_control",
]);

export async function diagnoseNotebook(options: {
	deno: string;
	cwd: string;
	path: string;
	runtimeBindings?: ReadonlySet<string> | undefined;
	runtimeHealth?: NotebookRuntimeHealthState | undefined;
	signal?: AbortSignal | undefined;
}): Promise<NotebookControlResult> {
	const runtimeHealth = options.runtimeHealth ?? "not_started";
	const healthMessage = formatRuntimeHealth(runtimeHealth);
	const path = boundText(options.path);
	let cells;
	try {
		cells = readNotebookJournalCodeCells(options.path);
	} catch (error) {
		const reason = boundText(
			error instanceof Error ? error.message : String(error),
		);
		return boundedDiagnosticResult(
			`${healthMessage}\nNotebook diagnostics could not read ${path}: ${reason}`,
			{ path, runtime: { state: runtimeHealth }, error: reason },
		);
	}
	if (cells.length === 0) {
		return boundedDiagnosticResult(
			`${healthMessage}\nNo historical static code cells to diagnose in ${path}`,
			{
				path,
				cells: 0,
				runtime: { state: runtimeHealth },
				diagnosticGroups: [],
			},
		);
	}

	const timeout = AbortSignal.timeout(DIAGNOSTIC_TIMEOUT_MS);
	const signal = options.signal
		? AbortSignal.any([options.signal, timeout])
		: timeout;
	signal.throwIfAborted();
	const lsp = new OneShotLspProcess({
		deno: options.deno,
		cwd: options.cwd,
		signal,
	});
	try {
		const rootUri = directoryUri(options.cwd);
		await lsp.request("initialize", {
			processId: process.pid,
			clientInfo: { name: "pi-notebook-diagnostics" },
			rootUri,
			workspaceFolders: [
				{
					uri: rootUri,
					name:
						options.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? "workspace",
				},
			],
			capabilities: {
				workspace: { configuration: false, workspaceFolders: false },
				textDocument: {
					diagnostic: {},
					publishDiagnostics: { relatedInformation: true },
				},
				notebookDocument: {
					synchronization: {
						dynamicRegistration: false,
						executionSummarySupport: false,
					},
				},
			},
			initializationOptions: { enable: true },
		});
		lsp.notify("initialized", {});

		const notebookUri = pathToFileURL(options.path).href;
		const documents = cells.map((cell) => ({
			cell,
			uri: notebookCellUri(options.path, cell.index, cell.id),
		}));
		lsp.notify("notebookDocument/didOpen", {
			notebookDocument: {
				uri: notebookUri,
				notebookType: "jupyter-notebook",
				version: 1,
				cells: documents.map(({ uri }) => ({ kind: 2, document: uri })),
			},
			cellTextDocuments: documents.map(({ cell, uri }) => ({
				uri,
				languageId: "typescript",
				version: 1,
				text: cell.source,
			})),
		});
		const reports: unknown[] = [];
		for (const { uri } of documents) {
			reports.push(
				await lsp.request("textDocument/diagnostic", { textDocument: { uri } }),
			);
		}
		const runtimeBindings = new Set([
			...HOST_BINDINGS,
			...(options.runtimeBindings ?? []),
		]);
		const diagnostics = reports.flatMap((report, index) =>
			parseDiagnosticReport(report, documents[index]!.cell, runtimeBindings),
		);
		lsp.notify("notebookDocument/didClose", {
			notebookDocument: { uri: notebookUri },
			cellTextDocuments: documents.map(({ uri }) => ({ uri })),
		});
		return formatNotebookDiagnostics(
			options.path,
			cells.length,
			diagnostics,
			runtimeHealth,
		);
	} catch (error) {
		if (options.signal?.aborted) throw error;
		const reason = boundText(
			timeout.aborted
				? `Deno diagnostics timed out after ${DIAGNOSTIC_TIMEOUT_MS}ms`
				: error instanceof Error
					? error.message
					: String(error),
		);
		return boundedDiagnosticResult(
			`${healthMessage}\nNotebook diagnostics could not complete: ${reason}`,
			{
				path,
				cells: cells.length,
				runtime: { state: runtimeHealth },
				error: reason,
			},
		);
	} finally {
		await lsp.shutdown();
	}
}

function notebookCellUri(path: string, index: number, id: string): string {
	return `deno-notebook-cell:${pathToFileURL(path).pathname}#${index + 1}-${encodeURIComponent(id)}`;
}

function directoryUri(path: string): string {
	const uri = pathToFileURL(path).href;
	return uri.endsWith("/") ? uri : `${uri}/`;
}
