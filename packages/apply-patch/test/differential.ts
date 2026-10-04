import assert from "node:assert/strict";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
	ExecutePatchError,
	executePatch,
	type PatchOutcome,
} from "../src/index.ts";

type Fixture = {
	name: string;
	input: string;
	files: Record<string, string | Uint8Array>;
	links?: Record<string, string>;
};
const wrap = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`;
function fixtures(): Fixture[] {
	const cases: Fixture[] = [];
	const contents = [
		"a\nb\nc\n",
		"a\r\nb\nc\r",
		" a \nb\t\nc\n",
		"a\rb\rc",
		"a",
		"a\n",
		"",
		"a\n\n",
		"a\na\n",
		"\ufeffa\nb\nc\n",
		"\u201ca\u201d\nb\nc\n",
	];
	const bodies = [
		"@@\n-a\n+A",
		"@@\n a\n+x",
		"@@\n+x",
		"@@\n-a",
		"@@\n-a\n+A\n ",
		"@@\n-a\n+A\n*** End of File",
		"@@\n a\n-b\n+B\n c",
		"@@ a\n-b\n+B",
		"@@\n-a\n+A\n@@\n-b\n+B",
		"@@\n-a\n+A\n@@\n-a\n+AA\n*** End of File",
		"@@\n a\n\n+x",
		'@@\n-"a"\n+A',
		"@@\n+x\n@@\n+y",
		"*** End of File\n@@\n+x",
	];
	for (const [i, contentsText] of contents.entries())
		for (const [j, body] of bodies.entries()) {
			cases.push({
				name: `lines-${i}-hunk-${j}`,
				input: wrap(`*** Update File: x\n${body}`),
				files: { x: contentsText },
			});
		}
	const malformed = [
		"",
		"hello",
		"*** Begin Patch",
		"*** End Patch",
		"*** Begin Patch\n*** End Patch\nextra",
		wrap("*** Update File: x"),
		wrap("*** Update File: x\n@@"),
		wrap("*** Update File: x\n@@\n@@"),
		wrap("*** Update File: x\n@@\n*** End of File"),
		wrap("*** Update File: x\n@@\n-b\nbad"),
		wrap("*** Update File: x\n*** Move to: dest"),
		wrap("*** Update File: x\n@@\n-b\n*** End of File\n+bad"),
		wrap("*** Environment ID: "),
		wrap("*** Environment ID: a\n*** Environment ID: b"),
		wrap("*** Add File: x\nbad"),
		wrap("*** Add File: "),
		wrap("*** Delete File: x\nbad"),
		wrap("*** Update File: x\n@@\n-b\n*** Update File: dest\n@@"),
	];
	for (const [index, input] of malformed.entries())
		cases.push({ name: `invalid-${index}`, input, files: { x: "b\n" } });
	for (const [index, input] of [
		wrap("*** Add File: made\n+x\n*** Delete File: x"),
		wrap("*** Add File: x\n+new"),
		wrap("*** Update File: x\n*** Move to: dest\n@@\n-a\n+A"),
		wrap("*** Update File: x\n*** Move to: nested/new\n@@\n-a\n+A"),
		wrap("*** Add File: made\n+ok\n*** Update File: missing\n@@\n-a\n+b"),
		wrap("*** Add File: made\n+ok\n*** Delete File: missing"),
		wrap("*** Environment ID: remote\n*** Update File: x\n@@\n-a\n+A"),
		`<<EOF\n${wrap("*** Update File: x\n@@\n-a\n+A")}\nignoredEOF`,
		`<<"EOF"\n${wrap("*** Update File: x\n@@\n-a\n+A")}\nEOF`,
		wrap("*** Update File: x\n@@\n-a\n+A").replaceAll("\n", "\r\n"),
		wrap("*** Update File: x\n@@\n-a\n+A").replaceAll("\n", "\r\r\n"),
		"  *** Begin Patch \n*** Update File: x\n@@\n-a\n+A\n *** End Patch  ",
		wrap("*** Update File: x\n@@\n-a\n+A\n *** Add File: literal\n-b\n+B"),
		wrap("*** Add File: 'quoted'\n+x"),
		wrap("*** Add File: @literal\n+x"),
		wrap("*** Add File: made\n+x") + "\n*** End Patch",
	].entries())
		cases.push({
			name: `operations-${index}`,
			input,
			files: { x: "a\nb\n", dest: "overwritten\n" },
		});
	cases.push({
		name: "indented-marker",
		input: wrap(
			"*** Update File: x\n@@\n a\n *** Update File: context\n-b\n+B",
		),
		files: { x: "a\n*** Update File: context\nb\n" },
	});
	cases.push({
		name: "invalid-utf8",
		input: wrap("*** Update File: x\n@@\n-\ufffd\n+x"),
		files: { x: new Uint8Array([255, 10]) },
	});
	for (const type of ["update", "delete", "add"] as const)
		cases.push({
			name: `symlink-${type}`,
			input: wrap(
				type === "update"
					? "*** Update File: link\n@@\n-a\n+A"
					: type === "add"
						? "*** Add File: link\n+A"
						: "*** Delete File: link",
			),
			files: { x: "a\n" },
			links: { link: "x" },
		});
	for (const type of ["update", "delete", "add"] as const)
		cases.push({
			name: `dangling-${type}`,
			input: wrap(
				type === "update"
					? "*** Update File: link\n@@\n-a\n+A"
					: type === "add"
						? "*** Add File: link\n+A"
						: "*** Delete File: link",
			),
			files: {},
			links: { link: "x" },
		});
	return cases;
}

async function seed(cwd: string, fixture: Fixture): Promise<void> {
	for (const [path, contents] of Object.entries(fixture.files)) {
		await mkdir(dirname(join(cwd, path)), { recursive: true });
		await writeFile(join(cwd, path), contents);
	}
	for (const [path, target] of Object.entries(fixture.links ?? {}))
		await symlink(target, join(cwd, path));
}
async function fileBytes(path: string): Promise<Buffer | null> {
	try {
		return await readFile(path);
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "ENOENT"
		)
			return null;
		throw error;
	}
}

test("differential outcomes, deltas, parser errors, and bytes match the pinned native helper", {
	skip: !process.env["APPLY_PATCH_REFERENCE"],
}, async () => {
	const reference = process.env["APPLY_PATCH_REFERENCE"];
	if (!reference)
		throw new Error(
			"Set APPLY_PATCH_REFERENCE to the existing pinned apply_patch binary",
		);
	const root = await mkdtemp(join(tmpdir(), "patch-differential-"));
	const cases = fixtures();
	try {
		for (const [index, fixture] of cases.entries()) {
			const nativeCwd = join(root, `${index}-native`);
			const tsCwd = join(root, `${index}-ts`);
			await Promise.all([mkdir(nativeCwd), mkdir(tsCwd)]);
			await Promise.all([seed(nativeCwd, fixture), seed(tsCwd, fixture)]);
			const native: SpawnSyncReturns<string> = spawnSync(reference, [], {
				cwd: nativeCwd,
				input: fixture.input,
				encoding: "utf8",
				env: { ...process.env, PI_APPLY_PATCH_JSON: "1" },
			});
			assert.ifError(native.error);
			if (fixture.input === "") {
				assert.equal(native.status, 2);
				await assert.rejects(
					executePatch(
						new NodeExecutionEnv({ cwd: tsCwd }),
						fixture.input,
						BACKGROUND_CONTEXT,
					),
					/invalid structured JSON output/,
				);
				continue;
			}
			// The CLI emits a human summary before its structured final JSON line.
			const parsed: unknown = JSON.parse(
				native.stdout.trim().split("\n").at(-1) ?? "null",
			);
			assert.ok(
				parsed &&
					typeof parsed === "object" &&
					"status" in parsed &&
					"result" in parsed &&
					"changes" in parsed &&
					"exact" in parsed &&
					"error" in parsed,
				fixture.name,
			);
			let outcome: PatchOutcome;
			let errorMessage: string | undefined;
			try {
				outcome = await executePatch(
					new NodeExecutionEnv({ cwd: tsCwd }),
					fixture.input,
					BACKGROUND_CONTEXT,
				);
			} catch (error) {
				assert.ok(error instanceof ExecutePatchError, fixture.name);
				outcome = error.outcome;
				errorMessage = error.message;
			}
			assert.equal(
				errorMessage === undefined ? "success" : "failure",
				parsed.status,
				fixture.name,
			);
			assert.deepEqual(outcome.result, parsed.result, fixture.name);
			assert.deepEqual(outcome.changes, parsed.changes, fixture.name);
			assert.equal(outcome.exact, parsed.exact, fixture.name);
			if (
				typeof parsed.error === "string" &&
				parsed.error.startsWith("invalid ")
			)
				assert.equal(errorMessage, parsed.error, fixture.name);
			const paths = new Set([
				...Object.keys(fixture.files),
				...Object.keys(fixture.links ?? {}),
				"made",
				"nested/new",
				"dest",
				"'quoted'",
				"@literal",
			]);
			for (const path of paths)
				assert.deepEqual(
					await fileBytes(join(tsCwd, path)),
					await fileBytes(join(nativeCwd, path)),
					`${fixture.name}: ${path}`,
				);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
	console.log(
		`Compared ${cases.length} fixture outcomes against the native reference`,
	);
});
