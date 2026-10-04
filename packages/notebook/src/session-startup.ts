// Adapted from pi-codex-conversion at b2006db9def12c373ae48e70044d30f7d6b7e34f, MIT. See ../NOTICE.

import { randomUUID } from "node:crypto";
import type { NotebookBridgeServer } from "./bridge-server.ts";
import {
	type NotebookCheckpointIdentity,
	restoreNotebookCheckpoint,
} from "./checkpoint.ts";
import { garbageCollectSupersededNotebookCheckpoints } from "./checkpoint-store.ts";
import { notebookExecStartupNotice } from "./control-contract.ts";
import { ensureNotebookDenoBinary } from "./deno-binary.ts";
import { initializeNotebookJournal, type NotebookJournal } from "./journal.ts";
import { DenoJupyterKernel } from "./jupyter-kernel.ts";
import { notebookToolHooksSource } from "./lifecycle-runtime.ts";
import { notebookBootstrapSource } from "./notebook-bootstrap.ts";
import {
	formatNotebookNpmImportsNotice,
	readNotebookNpmImports,
} from "./npm-imports.ts";
import {
	loadNotebookProfile,
	NotebookProfileRestoreError,
} from "./profile-state.ts";
import { resolveNotebookProject } from "./project-identity.ts";
import {
	type ProjectStateBaseline,
	restoreProjectState,
} from "./project-state.ts";
import { formatProjectStateNotice } from "./project-state-metadata.ts";
import type {
	NotebookRuntimeOptions,
	NotebookSessionContext,
} from "./runtime-contract.ts";
import { withNotebookRecoveryGuidance } from "./runtime-health.ts";
import { notebookSessionIdentity } from "./session-identity.ts";

export interface StartedNotebookSession {
	kernel: DenoJupyterKernel;
	journal: NotebookJournal;
	checkpointIdentity: NotebookCheckpointIdentity;
	baselineNames: Set<string>;
	projectBaseline: ProjectStateBaseline;
	configuredProfileLoaded: boolean;
	restoreNotice?: string | undefined;
}

export async function startNotebookSession(options: {
	context: NotebookSessionContext;
	runtime: NotebookRuntimeOptions;
	bridge: NotebookBridgeServer;
	checkpointMaxBytes: number;
	onKernelFailure?:
		| ((kernel: DenoJupyterKernel, error: Error) => void)
		| undefined;
	signal?: AbortSignal | undefined;
}): Promise<StartedNotebookSession> {
	const { context, runtime, bridge, signal } = options;
	const startupAbort = new AbortController();
	const startupSignal = signal
		? AbortSignal.any([signal, startupAbort.signal])
		: startupAbort.signal;
	const denoPending = ensureNotebookDenoBinary(
		{ agentDir: runtime.agentDir },
		startupSignal,
	);
	const bridgePending = bridge.start();
	let deno: string;
	let origin: string;
	try {
		[deno, origin] = await Promise.all([denoPending, bridgePending]);
		startupSignal.throwIfAborted();
	} catch (error) {
		startupAbort.abort();
		await Promise.allSettled([denoPending, bridgePending]);
		await bridge.shutdown().catch(() => undefined);
		if (signal?.aborted) throw error;
		throw notebookStartupError(error);
	}

	const kernel = new DenoJupyterKernel({
		deno,
		maxHeapMiB: runtime.maxHeapMiB,
		env: runtime.env,
		onFailure: options.onKernelFailure,
	});
	try {
		await kernel.start(signal);
		const bootstrap = await kernel.execute(
			notebookBootstrapSource(
				origin,
				bridge.token,
				bridge.exitToken,
				context.cwd,
			),
			{ signal },
		);
		if (bootstrap.status !== "ok") {
			throw new Error(
				`Notebook bootstrap failed: ${bootstrap.errorText ?? "unknown error"}`,
			);
		}
		const project = resolveNotebookProject(context.cwd);
		const checkpointIdentity = {
			project,
			session: notebookSessionIdentity(context),
			agentDir: runtime.agentDir,
		};
		const journal = initializeNotebookJournal(
			checkpointIdentity,
			options.checkpointMaxBytes,
		);
		const baselineNames = new Set(await kernel.complete("", 0, signal));
		const projectState = await restoreProjectState(kernel, {
			project,
			agentDir: runtime.agentDir,
			maxBytes: options.checkpointMaxBytes,
			signal,
		});
		const restored = await restoreNotebookCheckpoint(
			kernel,
			checkpointIdentity,
			options.checkpointMaxBytes,
			projectState.baseline,
			signal,
		);
		let profileNotice: string | undefined;
		let configuredProfileLoaded = false;
		if (runtime.profile) {
			try {
				const profile = await loadNotebookProfile({
					name: runtime.profile,
					kernel,
					agentDir: runtime.agentDir,
					baselineNames,
					maxBytes: options.checkpointMaxBytes,
					signal,
				});
				profileNotice =
					profile.collisions.length > 0
						? `Notebook profile ${runtime.profile} was not loaded because ${profile.collisions.length} binding collision(s) already exist`
						: `Notebook profile ${runtime.profile} loaded ${profile.loaded.length} binding(s)`;
				configuredProfileLoaded = profile.collisions.length === 0;
			} catch (error) {
				if (signal?.aborted || error instanceof NotebookProfileRestoreError)
					throw error;
				profileNotice = `Notebook profile ${runtime.profile} was not loaded: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
		const exampleNames = await installNotebookExamples(kernel, signal);
		for (const name of exampleNames) baselineNames.add(name);
		for (const { name } of projectState.restored
			.filter((entry) => entry.hook === "startup")
			.sort((a, b) => a.name.localeCompare(b.name))) {
			try {
				const result = await kernel.execute(
					`await (0, globalThis[${JSON.stringify(name)}])({type:"startup"}); undefined;`,
					{ signal },
				);
				if (result.status !== "ok")
					throw new Error(result.errorText ?? result.status);
			} catch (error) {
				throw new Error(
					`Notebook startup hook ${JSON.stringify(name)} failed: ${error instanceof Error ? error.message : String(error)}. To unpin it, call notebook with ${JSON.stringify({ input: JSON.stringify({ action: "unpin", names: [name] }) })}; external side effects were not rolled back`,
					{ cause: error },
				);
			}
		}
		const toolHooks = projectState.restored
			.filter((entry) => entry.hook === "tool_result")
			.map(({ name }) => name);
		if (toolHooks.length > 0) {
			const configured = await kernel.execute(
				notebookToolHooksSource(toolHooks, true),
				{ signal },
			);
			if (configured.status !== "ok")
				throw new Error(
					`Notebook tool hooks could not be restored: ${configured.errorText ?? configured.status}`,
				);
		}
		garbageCollectSupersededNotebookCheckpoints(checkpointIdentity);
		const npmNotice = formatNotebookNpmImportsNotice(
			readNotebookNpmImports(checkpointIdentity),
		);
		const exampleNotice =
			exampleNames.length === 2
				? "Notebook example foo/bar available; inspect foo.description, foo.usage, bar.description, and bar.usage before constructing a reusable global"
				: undefined;
		const restoreNotice =
			[
				exampleNotice,
				npmNotice,
				formatProjectStateNotice(projectState),
				restored.message,
				profileNotice,
				notebookExecStartupNotice(),
			]
				.filter(Boolean)
				.join(". ") || undefined;
		return {
			kernel,
			journal,
			checkpointIdentity,
			baselineNames,
			projectBaseline: projectState.baseline,
			configuredProfileLoaded,
			...(restoreNotice ? { restoreNotice } : {}),
		};
	} catch (error) {
		await kernel.shutdown().catch(() => undefined);
		await bridge.shutdown().catch(() => undefined);
		if (signal?.aborted) throw error;
		throw notebookStartupError(error);
	}
}

function notebookStartupError(error: unknown): Error {
	const message = withNotebookRecoveryGuidance(
		error instanceof Error ? error.message : String(error),
	);
	return error instanceof NotebookProfileRestoreError
		? new NotebookProfileRestoreError(message, { cause: error })
		: new Error(message, { cause: error });
}

async function installNotebookExamples(
	kernel: DenoJupyterKernel,
	signal?: AbortSignal,
): Promise<string[]> {
	const marker = `__PI_NOTEBOOK_EXAMPLES_${randomUUID()}__`;
	signal?.throwIfAborted();
	try {
		const names = new Set(await kernel.complete("", 0, signal));
		const result = await kernel.execute(
			notebookExampleSource(marker, names.has("foo") || names.has("bar")),
			{ signal },
		);
		if (result.status !== "ok") return [];
		const output = result.items
			.filter(({ type }) => type === "input_text")
			.map(({ text }) => text ?? "")
			.join("");
		const start = output.indexOf(marker);
		if (start === -1) return [];
		const value = JSON.parse(
			output.slice(start + marker.length).split("\n", 1)[0]!,
		) as unknown;
		return Array.isArray(value) &&
			value.every((name) => name === "foo" || name === "bar")
			? [...new Set(value)]
			: [];
	} catch {
		signal?.throwIfAborted();
		return [];
	}
}

function notebookExampleSource(marker: string, occupied = false): string {
	return `{
	  const __conflict = ${occupied} || "foo" in globalThis || "bar" in globalThis;
  let __injected = [];
  if (!__conflict) {
    const __foo = [
      { id: "alpha", value: "first example record" },
      { id: "bravo", value: "second example record" },
    ];
    const __bar = (__item) => Object.fromEntries(Object.entries(__item).slice(0, 4));
    Object.defineProperties(__foo, {
      description: { value: "Example records for reusable helper patterns", writable: true, configurable: true },
      usage: { value: "Inspect: foo.map((item, index) => ({ index, keys: Object.keys(item) }))", writable: true, configurable: true },
    });
    Object.defineProperties(__bar, {
      description: { value: "Summarize one foo item without mutating foo", writable: true, configurable: true },
      usage: { value: "Inspect: foo.map((item, index) => ({ index, keys: Object.keys(item) }))\\nRun: bar(foo[index])", writable: true, configurable: true },
    });
    try {
      Object.defineProperties(globalThis, {
        foo: { value: __foo, writable: true, configurable: true, enumerable: true },
        bar: { value: __bar, writable: true, configurable: true, enumerable: true },
      });
      __injected = ["foo", "bar"];
    } catch {
      delete globalThis.foo;
      delete globalThis.bar;
    }
  }
  console.log(${JSON.stringify(marker)} + JSON.stringify(__injected));
  undefined;
}`;
}
