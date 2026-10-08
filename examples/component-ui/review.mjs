import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createNativeGitReader } from "@howaboua/pi-durable-git/native";
import { stateSource } from "./channel.mjs";

function anchors(diff) {
	const result = [];
	let path = null;
	let oldPath = null;
	let inHunk = false;
	let oldLine = 0;
	let newLine = 0;
	for (const text of diff.split("\n")) {
		if (text.startsWith("diff --git")) {
			path = null;
			oldPath = null;
			inHunk = false;
		}
		if (!inHunk) {
			if (text.startsWith("--- a/")) oldPath = text.slice(6);
			if (text.startsWith("+++ b/")) path = text.slice(6);
			if (text === "+++ /dev/null") path = oldPath;
		}
		const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
		if (hunk) {
			inHunk = true;
			oldLine = Number(hunk[1]);
			newLine = Number(hunk[2]);
			continue;
		}
		if (!path || !inHunk || text.startsWith("\\")) continue;
		if (text.startsWith("-"))
			result.push({
				path: oldPath ?? path,
				side: "old",
				line: oldLine++,
				text,
			});
		else if (text.startsWith("+"))
			result.push({ path, side: "new", line: newLine++, text });
		else if (text.startsWith(" ")) {
			result.push({ path, side: "new", line: newLine++, text });
			oldLine++;
		}
	}
	return result;
}

export async function reviewChannel(cwd, store) {
	const reader = createNativeGitReader();
	if (!(await reader.isRepository(cwd)))
		throw new Error(`Not a Git worktree: ${cwd}`);
	let comments = [];
	try {
		comments = JSON.parse(await readFile(store, "utf8"));
		if (
			!Array.isArray(comments) ||
			comments.some(
				(c) =>
					typeof c.id !== "string" ||
					typeof c.revision !== "string" ||
					typeof c.path !== "string" ||
					!["old", "new"].includes(c.side) ||
					!Number.isSafeInteger(c.line) ||
					typeof c.body !== "string",
			)
		)
			throw new Error("Invalid comment store");
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	const state = stateSource({ revision: "", diff: "", anchors: [], comments });
	let queue = Promise.resolve();
	async function refresh(signal) {
		const result = await reader.diff(
			{ cwd, includeUntracked: true },
			{ signal },
		);
		const revision = createHash("sha256").update(result.diff).digest("hex");
		state.publish({
			revision,
			diff: result.diff,
			anchors: anchors(result.diff),
			comments,
		});
		return state.getSnapshot().value;
	}
	await refresh();
	return {
		...state,
		call(action, input, { signal }) {
			const operation = queue.then(async () => {
				signal.throwIfAborted();
				if (action === "refresh") return refresh(signal);
				if (action !== "comment") throw new Error("Action not granted");
				if (
					!input ||
					typeof input.body !== "string" ||
					!input.body.trim() ||
					input.body.length > 8000
				)
					throw new Error("Comment body required, maximum 8000 characters");
				const current = await refresh(signal);
				if (input.revision !== current.revision)
					throw new Error("Diff changed. Refresh and select an anchor again.");
				const anchor = current.anchors.find(
					(a) =>
						a.path === input.path &&
						a.side === input.side &&
						a.line === input.line,
				);
				if (!anchor) throw new Error("Anchor is not a displayed diff line");
				const comment = {
					id: randomUUID(),
					revision: current.revision,
					path: anchor.path,
					side: anchor.side,
					line: anchor.line,
					body: input.body.trim(),
					createdAt: new Date().toISOString(),
				};
				const next = [...comments, comment];
				await mkdir(dirname(store), { recursive: true });
				signal.throwIfAborted();
				const temporary = `${store}.${randomUUID()}.tmp`;
				// Once persistence starts, complete it even if the browser disconnects. Never retry it.
				try {
					await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
						mode: 0o600,
					});
					await rename(temporary, store);
				} finally {
					await rm(temporary, { force: true });
				}
				comments = next;
				state.publish({ ...current, comments });
				return comment;
			});
			queue = operation.catch(() => {});
			return operation;
		},
		close() {
			return queue;
		},
	};
}
