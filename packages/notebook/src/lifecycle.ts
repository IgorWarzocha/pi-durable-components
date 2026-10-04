// Adapted from pi-codex-conversion at b2006db9def12c373ae48e70044d30f7d6b7e34f, MIT. See ../NOTICE.
import type { NotebookLifecycleHost } from "./lifecycle-contract.ts";
import { inspectNotebookStatus } from "./lifecycle-inspection.ts";
import { NotebookPinController } from "./lifecycle-pins.ts";
import { NotebookReleaseController } from "./lifecycle-release.ts";
import { NotebookProfileController } from "./profile-lifecycle.ts";
import type {
	NotebookControlRequest,
	NotebookControlResult,
	ToolExecutionContext,
} from "./runtime-contract.ts";
export class NotebookLifecycleController {
	private readonly host: NotebookLifecycleHost;
	private readonly profiles: NotebookProfileController;
	private readonly pins: NotebookPinController;
	readonly releases: NotebookReleaseController;

	constructor(host: NotebookLifecycleHost) {
		this.host = host;
		this.profiles = new NotebookProfileController(host);
		this.pins = new NotebookPinController(host);
		this.releases = new NotebookReleaseController(host);
	}

	async control(
		request: NotebookControlRequest,
		context: ToolExecutionContext,
		signal?: AbortSignal,
	): Promise<NotebookControlResult> {
		if (request.action === "list") return this.profiles.list(request.query);
		if (request.action === "diagnostics")
			return this.host.diagnostics(context, signal);
		if (request.action === "reset") return this.host.reset(context, signal);
		if (
			request.action === "unpin" &&
			this.host.runtimeHealth().state !== "ready"
		)
			return this.host.unpinWithoutStartup(request.names, context, signal);
		if (
			request.action === "restart" &&
			this.host.runtimeHealth().state !== "ready"
		)
			return this.restart(context, signal);
		await this.host.prepare(context, signal);
		switch (request.action) {
			case "status":
				return inspectNotebookStatus(this.host, request.query, signal);
			case "checkpoint":
				return this.checkpoint();
			case "save":
				return this.profiles.save(request.name, context, signal);
			case "load":
				return this.profiles.load(request.name, context, signal);
			case "pin":
				return this.pins.pin(request.names, true, request.hook);
			case "unpin":
				return this.pins.pin(request.names, false);
			case "release":
				return this.releases.release(request.names, context, signal);
			case "prune":
				return this.releases.prune(request.query, context, signal);
			case "restart":
				return this.restart(context, signal);
		}
	}

	private async checkpoint(): Promise<NotebookControlResult> {
		await this.host.checkpoint();
		const details = this.host.metadata().checkpoint;
		return { message: "Notebook checkpoint complete", details };
	}

	private async restart(
		context: ToolExecutionContext,
		signal?: AbortSignal,
	): Promise<NotebookControlResult> {
		const activeCell = await this.host.stopActive();
		let checkpointNotice: string | undefined;
		if (!activeCell && this.host.runtimeHealth().state === "ready") {
			try {
				await this.host.checkpoint();
			} catch (error) {
				if (this.host.runtimeHealth().state !== "invalidated") throw error;
				checkpointNotice = `Checkpoint skipped after runtime invalidation: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
		const disposal = await this.releases.disposeAll(signal).catch((error) => ({
			released: [],
			disposed: [],
			failures: [
				{
					name: "notebook",
					reason: error instanceof Error ? error.message : String(error),
				},
			],
		}));
		const extension = context.sessionContext;
		if (!extension)
			throw new Error("Notebook restart requires a notebook session context");
		const restoreNotice = await this.host.restart(extension, signal);
		const details = {
			...(activeCell ? { terminatedCell: activeCell } : {}),
			disposed: disposal?.disposed ?? [],
			disposalFailures: disposal?.failures ?? [],
			...(restoreNotice ? { restoreNotice } : {}),
		};
		return {
			message: [
				`Notebook kernel restarted from the last completed checkpoint${activeCell ? `; terminated ${activeCell}` : ""}`,
				disposal && disposal.failures.length > 0
					? `${disposal.failures.length} resource cleanup failure${disposal.failures.length === 1 ? "" : "s"}; restart continued`
					: undefined,
				checkpointNotice,
				restoreNotice,
			]
				.filter(Boolean)
				.join(". "),
			details,
		};
	}
}
