import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
	ComponentCapabilities,
	modelsCapability,
	parseComponentPackage,
	prepareComponents,
} from "@howaboua/pi-durable-components";

// Only these explicitly approved, already installed packages can load here.
const packages = [
	"@howaboua/pi-durable-apply-patch",
	"@howaboua/pi-durable-context",
];
const selections = await Promise.all(
	packages.map(async (name) => {
		const entry = import.meta.resolve(`${name}/component`);
		const manifestPath = join(dirname(fileURLToPath(entry)), "../package.json");
		return {
			manifest: parseComponentPackage(
				JSON.parse(await readFile(manifestPath, "utf8")),
			),
			load: () => import(entry),
		};
	}),
);
const context = BACKGROUND_CONTEXT;
const models = createModels();
const faux = fauxProvider();
faux.setResponses([fauxAssistantMessage("The portable host is connected.")]);
models.setProvider(faux.provider);
const active = new Set();
const prepared = await prepareComponents(
	selections,
	{
		capabilities: new ComponentCapabilities().provide(modelsCapability, models),
		compatibility: {
			runtime: "node",
			peers: {
				"@earendil-works/chord": "1.4.0",
				"@earendil-works/pi-ai": "1.4.0",
				"@earendil-works/pi-durable": "1.4.0",
				"@modelcontextprotocol/sdk": "1.32.0",
			},
		},
		// This host tracks all its own admitted work. A real app must include every ingress.
		whenIdle: async () => {
			await Promise.all(active);
		},
	},
	context,
);
if (prepared.skipped.length) throw new Error(JSON.stringify(prepared.skipped));
const registry = createRegistry();
for (const extension of prepared.extensions) registry.install(extension);
for (const provider of prepared.providers) models.setProvider(provider);
const directory = await mkdtemp(join(tmpdir(), "durable-marketplace-"));
const storage = await openNodeSqliteStorage(join(directory, "agent.sqlite"));
const harness = await Harness.open(storage, { models, registry }, context);
try {
	await prepared.bind({ harness, storage }, context);
	const selected = prepared.extensions.map((extension) => extension.name);
	prepared.assertSelection(selected);
	const conversation = await harness.root(context, {
		agent: {
			model: { provider: "faux", modelId: "faux-1" },
			extensions: prepared.extensions,
		},
	});
	const admission = prepared.admissionFor(selected);
	if (!admission)
		throw new Error("This demonstration selects Context admission");
	const input = await admission.submit(
		conversation.id,
		{ type: "input", content: "Hello", requestId: "portable-example-1" },
		context,
	);
	const completion = harness.waitForTask(input.taskId, context);
	active.add(completion);
	try {
		console.log("Native placement:", await input.waitForSubmission(context));
		const result = await completion;
		console.log("Managed task:", result.state.outcome.status);
	} finally {
		active.delete(completion);
	}
	await prepared.retire(context);
	await prepared.maintain(context);
	const retry = await admission.rejoin?.(
		conversation.id,
		"portable-example-1",
		context,
	);
	console.log(
		"Retired generation rejoined original task:",
		retry?.taskId === input.taskId,
	);
} finally {
	// No more ingress. Before-close may cancel owned work without waiting for live idle.
	await prepared.closeBeforeHarness(context);
	await harness.close(context);
	await prepared.closeAfterHarness(context);
	await storage.close();
	await rm(directory, { recursive: true });
}
