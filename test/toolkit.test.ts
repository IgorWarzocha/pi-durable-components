import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
	createRegistry,
	defineExtension,
	Harness,
	MemoryStorage,
	type SettledTask,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-durable/tools";
import { createAgents } from "../packages/agents/src/index.ts";
import { ApplyPatch } from "../packages/apply-patch/src/index.ts";
import {
	createBrowserExtension,
	nodeArtifactStore,
} from "../packages/browser/src/index.ts";
import {
	createCodeMode,
	createNodeShellBackend,
} from "../packages/code/src/index.ts";
import {
	createContextManagement,
	type InputResult,
} from "../packages/context/src/index.ts";
import { createImageGenerationExtension } from "../packages/imagegen/src/index.ts";
import { createNotebookMode } from "../packages/notebook/src/index.ts";
import { skills } from "../packages/skills/src/index.ts";
import { createViewImageTool } from "../packages/view-image/src/index.ts";
import { createWebSearchExtension } from "../packages/web/src/index.ts";

const context = BACKGROUND_CONTEXT;
const ordinaryNames = [
	"read",
	"write",
	"apply_patch",
	"view_image",
	"skills",
	"agents",
	"board",
	"browser",
	"web_run",
	"imagegen",
	"exec_command",
	"write_stdin",
	"notes",
	"history",
	"get_context_remaining",
];
type Mode = "code" | "notebook";

// Only model routing is scripted. Every tool result comes from the installed component.
test("use the actual toolkit through Code, switch to Notebook, and retain each mode's state", {
	timeout: 240_000,
}, async () => {
	const directory = await mkdtemp(join(tmpdir(), "durable-toolkit-"));
	const env = new NodeExecutionEnv({ cwd: directory });
	const storage = new MemoryStorage();
	const models = createModels();
	const faux = fauxProvider({
		models: [{ id: "toolkit", input: ["text", "image"] }],
	});
	models.setProvider(faux.provider);
	const management = createContextManagement({ models });
	const files = defineExtension({
		name: "files",
		tools: [createReadTool(), createWriteTool()],
	});
	const agents = createAgents({
		profiles: {
			reader: {
				description: "Read the actual patched file in a persistent worker",
				agent: { extensions: [files] },
			},
		},
	});
	const browser = createBrowserExtension({
		stateDirectory: join(directory, "browser-state"),
		artifacts: nodeArtifactStore(join(directory, "browser-artifacts")),
	});
	let harness: Harness | undefined;
	const cancelTask = (
		id: Parameters<Harness["abortTask"]>[0],
		ctx: Parameters<Harness["abortTask"]>[1],
	) => {
		assert.ok(harness);
		return harness.abortTask(id, ctx);
	};
	const code = createCodeMode({
		shell: { backend: createNodeShellBackend({ environmentId: env.id }) },
		cancelTask,
	});
	const notebook = createNotebookMode({
		stateDirectory: join(directory, "notebook-state"),
		native: { environmentId: env.id },
		maxHeapMiB: 512,
		shell: { backend: createNodeShellBackend({ environmentId: env.id }) },
		cancelTask,
	});
	try {
		const ordinary = [
			files,
			ApplyPatch,
			defineExtension({
				name: "images",
				tools: [createViewImageTool({ models })],
			}),
			skills({ sessionRoot: "library" }),
			agents.extension,
			browser.extension,
			createWebSearchExtension({ models }),
			createImageGenerationExtension({ models }),
			management.extension,
		];
		const registry = createRegistry();
		for (const extension of [...ordinary, code.extension, notebook.extension])
			registry.install(extension);
		const observed: ToolResultMessage[] = [];
		let active: Mode = "code";
		let program = "";
		let workerReads = 0;
		let call = 0;
		faux.setResponses(
			Array.from({ length: 100 }, () => (request) => {
				const input = request.messages.findLast(
					(message) => message.role === "user",
				);
				const last = request.messages.findLast(
					(message) => message.role !== "system",
				);
				const user = messageText(input);
				if (user.startsWith("[Task from") || user.startsWith("[Message from")) {
					if (last?.role === "toolResult") {
						assert.equal(last.isError, false);
						workerReads++;
						return fauxAssistantMessage(`worker read: ${messageText(last)}`);
					}
					const path = user.match(/READ (\S+)/)?.[1];
					assert.ok(path, user);
					return fauxAssistantMessage(
						fauxToolCall("read", { path }, { id: `read-${++call}` }),
						{ stopReason: "toolUse" },
					);
				}
				const offered = new Set(
					request.messages
						.filter((message) => message.role === "system")
						.flatMap(
							(message) => message.toolsAdded?.map((tool) => tool.name) ?? [],
						),
				);
				assert.deepEqual(
					[...offered].sort(),
					active === "code"
						? ["exec", "new_context", "wait"]
						: ["exec", "new_context", "notebook", "wait"],
					"ordinary tools must fold automatically into the selected execution surface",
				);
				if (last?.role === "toolResult") {
					observed.push(last);
					assert.equal(last.isError, false, messageText(last));
					if (user === `toolkit:${active}:rollover`) {
						return fauxAssistantMessage(
							fauxToolCall("new_context", {}, { id: `rotate-${++call}` }),
							{ stopReason: "toolUse" },
						);
					}
					const details = last.details;
					if (
						details &&
						typeof details === "object" &&
						"status" in details &&
						details["status"] === "running"
					) {
						const id = messageText(last).match(/exec cell "([0-9]+)"/)?.[1];
						assert.ok(id, "the yielded cell handle must be model-visible");
						return fauxAssistantMessage(
							fauxToolCall(
								"wait",
								{ cell_id: id, yield_time_ms: 1000 },
								{ id: `wait-${++call}` },
							),
							{ stopReason: "toolUse" },
						);
					}
					return fauxAssistantMessage("toolkit complete");
				}
				if (user === "Continue from your saved notes.") {
					assert.equal(
						request.messages.some(
							(message) =>
								message.role === "user" &&
								messageText(message).startsWith("toolkit:"),
						),
						false,
						"rollover must remove the old active transcript",
					);
					program =
						active === "code"
							? 'text(load("toolkit"));'
							: "text(toolkitState);";
				}
				return fauxAssistantMessage(
					fauxToolCall("exec", { code: program }, { id: `exec-${++call}` }),
					{ stopReason: "toolUse" },
				);
			}),
		);
		// A valid 2x2 RGBA PNG. The actual view_image codec validates these bytes.
		const pixel = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWN4b+zwH4QZYAwAVTwJhXiB6kQAAAAASUVORK5CYII=",
			"base64",
		);
		await writeFile(join(directory, "pixel.png"), pixel);
		harness = await Harness.open(
			storage,
			{
				models,
				registry,
				env: () => env,
				settings: { retry: { enabled: false } },
			},
			context,
		);
		agents.bind(harness, storage);
		management.bind(harness, storage);
		code.bind(harness);
		notebook.bind(harness);
		const root = await harness.root(context, {
			agent: {
				model: { provider: faux.getModel().provider, modelId: "toolkit" },
				extensions: [...ordinary, code.extension],
			},
		});
		for (const mode of ["code", "notebook"] as const) {
			active = mode;
			await root.configure(
				{
					extensions: [
						...ordinary,
						mode === "code" ? code.extension : notebook.extension,
					],
				},
				context,
			);
			program = workflow(mode);
			observed.length = 0;
			assert.equal(
				(
					await (
						await root.submit(
							{ type: "input", content: `toolkit:${mode}` },
							context,
						)
					).wait(context)
				).status,
				"done",
			);
			const output = observed.map(messageText).join("\n");
			for (const marker of [
				"CATALOG",
				"Applied patch successfully",
				`${mode}:patched`,
				"PTY ready",
				"PTY:ping",
				"interop",
				"Follow the filesystem evidence",
				"worker read:",
				`BOARD_READ:${mode}`,
				"BROWSER_HELP",
				"WEB_UNAVAILABLE",
				"IMAGEGEN_UNAVAILABLE",
				`FINISHED:${mode}`,
			])
				assert.ok(output.includes(marker), `Missing ${marker}: ${output}`);
			const catalog = output.match(/CATALOG (\[[^\n]+\])/)?.[1];
			assert.ok(catalog, output);
			const names: unknown = JSON.parse(catalog);
			assert.ok(Array.isArray(names));
			for (const name of ordinaryNames)
				assert.ok(
					names.includes(name),
					`Missing ordinary registration ${name}`,
				);
			assert.equal(
				await readFile(join(directory, `${mode}.txt`), "utf8"),
				`${mode}:patched\n`,
			);
			assert.equal(
				await readFile(join(directory, `${mode}-shell.txt`), "utf8"),
				`${mode}:patched\n`,
			);
			assert.deepEqual(await readFile(join(directory, `${mode}.png`)), pixel);
			const images = observed.flatMap((result) =>
				result.content.filter((item) => item.type === "image"),
			);
			assert.ok(
				images.some(
					(item) =>
						item.mimeType === "image/png" &&
						item.data === pixel.toString("base64"),
				),
				"view_image must deliver the unchanged shell-copied PNG to the model",
			);
			program =
				'text(await tools.notes({action:"write_file",path:"handoff",text:"Retain toolkit state"})); text(ALL_TOOLS.some(t => t.name === "new_context")); try { await tools.new_context({}); throw new Error("nested rollover escaped"); } catch (error) { text(String(error)); }';
			observed.length = 0;
			const rollover = await management.submit(
				root.id,
				{ type: "input", content: `toolkit:${mode}:rollover` },
				context,
			);
			const rolloverResult: SettledTask<InputResult> =
				await harness.waitForTask(rollover, context);
			assert.equal(
				rolloverResult.state.outcome.status,
				"completed",
				JSON.stringify(rolloverResult.state.outcome),
			);
			if (rolloverResult.state.outcome.status === "completed")
				assert.equal(rolloverResult.state.outcome.result.status, "done");
			const rolloverOutput = observed.map(messageText).join("\n");
			assert.match(rolloverOutput, /false/);
			assert.doesNotMatch(rolloverOutput, /nested rollover escaped/);
			assert.match(
				rolloverOutput,
				new RegExp(`"mode":"${mode}"`),
				"the same live execution state must survive the context cut",
			);
		}
		assert.equal(
			workerReads,
			2,
			"each mode must dispatch a real worker that invokes read",
		);
		// Both components are installed throughout. Selection switches in one conversation.
		for (const mode of ["code", "notebook"] as const) {
			active = mode;
			await root.configure(
				{
					extensions: [
						...ordinary,
						mode === "code" ? code.extension : notebook.extension,
					],
				},
				context,
			);
			program =
				mode === "code"
					? 'text(load("toolkit"));'
					: 'text(toolkitState); text(await tools.notebook({action:"status"}));';
			observed.length = 0;
			assert.equal(
				(
					await (
						await root.submit(
							{ type: "input", content: `toolkit:${mode}:resume` },
							context,
						)
					).wait(context)
				).status,
				"done",
			);
			assert.match(
				observed.map(messageText).join("\n"),
				new RegExp(`"mode":"${mode}"`),
			);
		}
	} finally {
		await Promise.all([code.close(), notebook.close(), browser.close()]);
		await harness?.close(context);
		await rm(directory, { recursive: true, force: true });
	}
});

function messageText(message: Message | undefined): string {
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	return (
		message.content
			?.filter((item) => item.type === "text")
			.map((item) => item.text)
			.join("\n") ?? ""
	);
}

function workflow(mode: Mode): string {
	const patch = `*** Begin Patch\n*** Update File: ${mode}.txt\n@@\n-${mode}:initial\n+${mode}:patched\n*** End Patch`;
	const skill =
		"---\nname: interop\ndescription: Toolkit filesystem workflow\n---\nFollow the filesystem evidence.\n";
	const shell = `cat ${mode}.txt | tee ${mode}-shell.txt; cp pixel.png ${mode}.png`;
	const pty = `node -e 'process.stdout.write("PTY ready\\n");process.stdin.once("data",d=>{process.stdout.write("PTY:"+d);process.exit(0)})'`;
	return `// @exec: {"yield_time_ms":0,"max_output_tokens":10000}
{
  text("CATALOG " + JSON.stringify(ALL_TOOLS.map(tool => tool.name)));
  text(await tools.write({path:${JSON.stringify(`${mode}.txt`)},content:${JSON.stringify(`${mode}:initial\n`)}}));
  text(await tools.read({path:${JSON.stringify(`${mode}.txt`)}}));
  text(await tools.apply_patch({input:${JSON.stringify(patch)}}));
  text(await tools.exec_command({cmd:${JSON.stringify(shell)},yield_time_ms:1000}));
  const pty = await tools.exec_command({cmd:${JSON.stringify(pty)},tty:true,yield_time_ms:1000});
  text(pty);
  if (!pty.session_id) throw new Error("PTY session was not retained");
  text(await tools.write_stdin({session_id:pty.session_id,chars:"ping\\n",yield_time_ms:1000}));
  text(await tools.read({path:${JSON.stringify(`${mode}-shell.txt`)}}));
  image(await tools.view_image({path:${JSON.stringify(`${mode}.png`)},detail:"original"}));
  text(await tools.write({path:"library/interop/SKILL.md",content:${JSON.stringify(skill)}}));
  text(await tools.skills({command:"list"}));
  text(await tools.skills({command:"read interop"}));
  text(await tools.agents({action:"help"}));
  text(await tools.agents({action:"spawn",agent_type:"reader",label:"Filesystem reader",message:${JSON.stringify(`READ ${mode}.txt`)},blocking:true}));
  text(await tools.agents({action:"list"}));
  text(await tools.board({action:"help"}));
  const posted = await tools.board({action:"post",new_channel_name:${JSON.stringify(`interop-${mode}`)},text:${JSON.stringify(`BOARD_READ:${mode}`)}});
  text(await tools.board({action:"read_post",message_id:posted.message_id}));
  text("BROWSER_HELP"); text(await tools.browser({command:"help"}));
  // No configured remote provider and no billable requests. Live provider checks are separate.
  try { await tools.web_run({search_query:[{q:"Durable toolkit"}]}); throw new Error("unexpected web success"); }
  catch (error) { if (!String(error).includes("Codex-compatible")) throw error; text("WEB_UNAVAILABLE " + error); }
  try { await tools.imagegen({prompt:"2x2 square red image, low quality"}); throw new Error("unexpected imagegen success"); }
  catch (error) { if (!String(error).includes("Codex-compatible")) throw error; text("IMAGEGEN_UNAVAILABLE " + error); }
  ${mode === "notebook" ? 'text(await tools.notebook({action:"status"}));' : 'store("toolkit", {mode:"code",value:42});'}
  text("FINISHED:${mode}");
}
${mode === "notebook" ? 'var toolkitState = {mode:"notebook",value:42};' : ""}`;
}
