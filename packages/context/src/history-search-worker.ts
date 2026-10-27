// Adapted from Pi Stuff 1338b66a, Copyright (c) 2026 Igor Warzocha, MIT.
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

export type HistoryWorkerOptions = {
	path: string;
	scope: string;
	match: string | undefined;
	limit: number | undefined;
	recentFirst: boolean | undefined;
};
export type HistoryWorkerMessage =
	| { items: readonly { id: string; content: string }[] }
	| { finish: true };

const port = parentPort;
if (!port) throw new Error("History index requires a worker thread");
const options: HistoryWorkerOptions = workerData;
let database: DatabaseSync | undefined;
try {
	mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
	const db = new DatabaseSync(options.path);
	database = db;
	const prepare = (sql: string) => {
		const statement = db.prepare(sql);
		// FTS shadow-table rowids can exceed Number.MAX_SAFE_INTEGER even for
		// tiny corpora. run() exposes them as lastInsertRowid too.
		statement.setReadBigInts(true);
		return statement;
	};
	db.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
	db.exec(
		"CREATE TABLE IF NOT EXISTS ranked_history_documents (id INTEGER PRIMARY KEY, scope TEXT NOT NULL, item TEXT NOT NULL, fingerprint TEXT NOT NULL, UNIQUE(scope,item)); CREATE VIRTUAL TABLE IF NOT EXISTS ranked_history_terms USING fts5(content, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2')",
	);
	const existing = prepare(
		"SELECT id, fingerprint FROM ranked_history_documents WHERE scope=? AND item=?",
	);
	const insert = prepare(
		"INSERT INTO ranked_history_documents(scope,item,fingerprint) VALUES (?,?,?)",
	);
	const removeTerms = prepare("DELETE FROM ranked_history_terms WHERE rowid=?");
	const addTerms = prepare(
		"INSERT INTO ranked_history_terms(rowid,content) VALUES (?,?)",
	);
	const update = prepare(
		"UPDATE ranked_history_documents SET fingerprint=? WHERE id=?",
	);
	db.exec(
		"CREATE TEMP TABLE search_scope (id INTEGER PRIMARY KEY, position INTEGER NOT NULL)",
	);
	const addScope = prepare(
		"INSERT INTO search_scope VALUES (?,CAST(? AS INTEGER))",
	);
	port.on("message", (message: HistoryWorkerMessage) => {
		try {
			if ("items" in message) {
				for (const item of message.items) {
					if (!/^[1-9][0-9]*$/.test(item.id))
						throw new Error(
							"History index requires canonical Durable entry IDs",
						);
					const previous = existing.get(options.scope, item.id);
					if (
						previous &&
						(typeof previous["id"] !== "bigint" ||
							typeof previous["fingerprint"] !== "string")
					)
						throw new Error("Invalid history index metadata");
					const fingerprint = createHash("sha256")
						.update(item.content)
						.digest("hex");
					const id =
						previous?.["id"] ??
						insert.run(options.scope, item.id, fingerprint).lastInsertRowid;
					if (!previous || previous["fingerprint"] !== fingerprint) {
						if (previous) {
							removeTerms.run(id);
							update.run(fingerprint, id);
						}
						addTerms.run(id, item.content);
					}
					addScope.run(id, item.id);
				}
				port.postMessage({ ready: true });
				return;
			}
			// Only complete refreshes remove stale documents. A search can have
			// narrower role/window filters without destroying the wider index.
			if (options.match === undefined) {
				for (const previous of prepare(
					"SELECT id FROM ranked_history_documents WHERE scope=? AND id NOT IN (SELECT id FROM search_scope)",
				).iterate(options.scope)) {
					if (typeof previous["id"] !== "bigint")
						throw new Error("Invalid history index ID");
					removeTerms.run(previous["id"]);
				}
				prepare(
					"DELETE FROM ranked_history_documents WHERE scope=? AND id NOT IN (SELECT id FROM search_scope)",
				).run(options.scope);
			}
			const ids: string[] = [];
			if (options.match !== undefined) {
				for (const row of prepare(
					"SELECT d.item FROM ranked_history_terms JOIN search_scope s ON s.id=ranked_history_terms.rowid JOIN ranked_history_documents d ON d.id=s.id WHERE ranked_history_terms MATCH ? ORDER BY " +
						(options.recentFirst ? "s.position DESC" : "rank, s.position") +
						" LIMIT ?",
				).all(options.match, options.limit ?? 25)) {
					if (typeof row["item"] !== "string")
						throw new Error("Invalid history index item ID");
					ids.push(row["item"]);
				}
			}
			db.exec("COMMIT");
			db.close();
			database = undefined;
			port.postMessage({ ids });
		} catch (error) {
			fail(error);
		}
	});
	port.postMessage({ ready: true });
} catch (error) {
	fail(error);
}

function fail(error: unknown): void {
	database?.close();
	database = undefined;
	port?.postMessage({ error: String(error) });
}
