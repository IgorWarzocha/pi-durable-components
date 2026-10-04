import type { Context } from "@earendil-works/chord";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { type Static, Type } from "typebox";
import { formatUnifiedExecResult } from "./shell/format.ts";
import {
	createExecSessionManager,
	type ExecSessionManagerOptions,
	type UnifiedExecResult,
} from "./shell/session-manager.ts";
import { MAX_EXEC_YIELD_TIME_MS } from "./shell/shell.ts";

export type {
	ShellOutputStream,
	ShellProcess,
	ShellProcessBackend,
	ShellProcessEvents,
	ShellSpawnRequest,
} from "./shell/backend.ts";
export {
	createNodeShellBackend,
	type NodeShellBackendOptions,
} from "./shell/node-backend.ts";

export interface ShellRuntimeOptions extends ExecSessionManagerOptions {
	waitForNonInteractiveExit?: boolean;
}

export interface ShellRuntime {
	readonly tools: readonly ToolRegistration[];
	/** Idempotently terminate owned sessions. The Code or Notebook connection owns this call. */
	close(): Promise<void>;
}

const execSchema = Type.Object({
	cmd: Type.String({
		description: "Shell command; do not quote the entire command",
	}),
	workdir: Type.Optional(Type.String({ description: "Cwd" })),
	shell: Type.Optional(Type.String()),
	tty: Type.Optional(
		Type.Boolean({ description: "Keep stdin open for input or interruption" }),
	),
	yield_time_ms: Type.Optional(Type.Number({ description: "Wait ms" })),
	max_output_tokens: Type.Optional(Type.Number({ description: "Truncate" })),
	login: Type.Optional(Type.Boolean()),
});

const writeSchema = Type.Object({
	session_id: Type.Number(),
	chars: Type.Optional(
		Type.String({
			description:
				"Input requires original exec_command tty=true; omit or empty to poll",
		}),
	),
	yield_time_ms: Type.Optional(Type.Number({ description: "Wait ms" })),
	max_output_tokens: Type.Optional(Type.Number({ description: "Truncate" })),
});

// Shell retention and max_output_tokens already bound delivery. Do not add a second,
// smaller byte or line cap when the same registration runs through generic dispatch.
const outputLimits = {
	maxBytes: Number.MAX_SAFE_INTEGER,
	maxLines: Number.MAX_SAFE_INTEGER,
	retain: "tail" as const,
};

/** Ordinary Durable registrations shared internally by both public execution modes. */
export function createShellRuntime(options: ShellRuntimeOptions): ShellRuntime {
	if (!options.backend?.environmentId)
		throw new Error(
			"Shell runtime requires an explicitly namespace-bound process backend",
		);
	const sessions = createExecSessionManager(options);
	const ensureEnvironment = (env: ExecutionEnv | undefined) => {
		if (!env) throw new Error("Shell tools require an execution environment");
		if (env.id !== options.backend.environmentId)
			throw new Error(
				`Shell process backend is bound to environment ${options.backend.environmentId}, not ${env.id}; select a backend for this environment`,
			);
		return env;
	};
	const exec = defineTool<typeof execSchema, UnifiedExecResult>({
		name: "exec_command",
		description: "Run shell commands; may return session_id",
		parameters: execSchema,
		replay: "unsafe",
		prepareArguments: prepareExecArguments,
		outputLimits,
		async execute(args, api, context) {
			context.abortSignal?.throwIfAborted();
			const env = ensureEnvironment(api.env);
			// Path interpretation belongs to the environment, including remote and sandbox namespaces.
			const cwd = args.workdir
				? getOrThrow(await env.absolutePath(args.workdir, context))
				: env.cwd;
			const input = {
				...args,
				workdir: cwd,
				...(!args.tty
					? {
							max_yield_time_ms: MAX_EXEC_YIELD_TIME_MS,
							wait_until_exit: options.waitForNonInteractiveExit ?? false,
						}
					: {}),
			};
			const updates = createUpdates(
				(partial) => api.details(partial, context),
				context,
			);
			try {
				const result = await sessions.exec(
					input,
					cwd,
					context.abortSignal,
					updates.emit,
				);
				await updates.flush();
				return toToolResult(result);
			} finally {
				await updates.flush();
			}
		},
	});
	const write = defineTool<typeof writeSchema, UnifiedExecResult>({
		name: "write_stdin",
		description: "Write/poll exec session",
		parameters: writeSchema,
		replay: "unsafe",
		outputLimits,
		async execute(args, api, context) {
			ensureEnvironment(api.env);
			const updates = createUpdates(
				(partial) => api.details(partial, context),
				context,
			);
			try {
				const result = await sessions.write(
					args,
					context.abortSignal,
					updates.emit,
				);
				await updates.flush();
				return toToolResult(result);
			} catch (error) {
				throw new Error(
					`write_stdin failed: ${error instanceof Error ? error.message : String(error)}`,
					{ cause: error },
				);
			} finally {
				await updates.flush();
			}
		},
	});
	return {
		tools: Object.freeze([exec, write]),
		close: () => sessions.shutdown(),
	};
}

function toToolResult(result: UnifiedExecResult) {
	return {
		content: [{ type: "text" as const, text: formatUnifiedExecResult(result) }],
		details: result,
	};
}

function prepareExecArguments(args: unknown): Static<typeof execSchema> {
	if (!args || typeof args !== "object")
		throw new Error("exec_command requires an object parameter");
	const prepared = { ...(args as Record<string, unknown>) };
	if (!("cmd" in prepared) && "command" in prepared)
		prepared["cmd"] = prepared["command"];
	if (!("workdir" in prepared)) {
		if ("cwd" in prepared) prepared["workdir"] = prepared["cwd"];
		else if ("working_directory" in prepared)
			prepared["workdir"] = prepared["working_directory"];
	}
	return prepared as Static<typeof execSchema>;
}

/** Observe update failures immediately, drain all invocation-bound writes before returning. */
function createUpdates(
	write: (result: UnifiedExecResult) => Promise<void>,
	context: Context,
) {
	let pending = Promise.resolve();
	let failure: unknown;
	return {
		emit: (result: UnifiedExecResult) => {
			pending = pending.then(async () => {
				if (failure !== undefined || context.abortSignal?.aborted) return;
				try {
					await write(result);
				} catch (error) {
					failure = error;
				}
			});
		},
		flush: async () => {
			await pending;
			if (failure !== undefined && !context.abortSignal?.aborted) throw failure;
		},
	};
}
