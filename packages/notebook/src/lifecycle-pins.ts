// Adapted from pi-codex-conversion at b2006db9def12c373ae48e70044d30f7d6b7e34f, MIT. See ../NOTICE.
import type { NotebookLifecycleHost } from "./lifecycle-contract.ts";
import {
	NOTEBOOK_BINDING_IDENTIFIER,
	notebookUserBindingNames,
} from "./lifecycle-inspection.ts";
import {
	formatNameList,
	NOTEBOOK_DETAILS_BUDGET,
	takeDetailValues,
	withinNameBudget,
} from "./lifecycle-result.ts";
import { notebookToolHooksSource } from "./lifecycle-runtime.ts";
import type {
	NotebookControlResult,
	NotebookHook,
} from "./runtime-contract.ts";
import { withNotebookRecoveryGuidance } from "./runtime-health.ts";

type BindingHost = Pick<
	NotebookLifecycleHost,
	| "kernel"
	| "activeCellId"
	| "retainedBindings"
	| "baselineNames"
	| "promoteBindings"
	| "checkpoint"
>;
export class NotebookPinController {
	private readonly host: BindingHost;
	constructor(host: BindingHost) {
		this.host = host;
	}
	async pin(
		names: string[],
		pinned: boolean,
		hook?: NotebookHook | false,
	): Promise<NotebookControlResult> {
		const activeCell = this.host.activeCellId();
		if (activeCell)
			throw new Error(
				`Cannot change notebook pins while exec cell "${activeCell}" is running`,
			);
		const selectedNames = new Set(names);
		const previousToolResultHooks = new Set(
			this.host
				.retainedBindings()
				.filter(
					(binding) =>
						selectedNames.has(binding.name) && binding.hook === "tool_result",
				)
				.map(({ name }) => name),
		);
		let rollbackPromotion: (() => Promise<void>) | undefined;
		if (pinned) {
			const kernel = this.host.kernel()!;
			const available = new Set(
				await notebookUserBindingNames(this.host, kernel),
			);
			const invalid = names.filter(
				(name) =>
					!NOTEBOOK_BINDING_IDENTIFIER.test(name) || !available.has(name),
			);
			if (invalid.length > 0)
				throw new Error(
					`Notebook bindings not found or not pinnable: ${invalid.join(", ")}`,
				);
			rollbackPromotion = await this.host.promoteBindings(names);
		}
		const configureHooks = !pinned || hook !== undefined;
		let hooksConfigured = false;
		try {
			if (configureHooks) {
				await this.configureToolHooks(names, pinned && hook === "tool_result");
				hooksConfigured = true;
			}
			await this.host.checkpoint(undefined, { names, pinned, hook });
		} catch (error) {
			const recoveryFailures: string[] = [];
			if (hooksConfigured) {
				try {
					await this.configureToolHooks(names, false);
					if (previousToolResultHooks.size > 0)
						await this.configureToolHooks([...previousToolResultHooks], true);
				} catch (recoveryError) {
					recoveryFailures.push(
						`hook registration: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
					);
				}
			}
			if (rollbackPromotion) {
				try {
					await rollbackPromotion();
				} catch (recoveryError) {
					recoveryFailures.push(
						`promotion tracking: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
					);
				}
			}
			if (recoveryFailures.length > 0) {
				const reason = error instanceof Error ? error.message : String(error);
				throw new Error(
					withNotebookRecoveryGuidance(
						`${reason}. Durable pin and hook metadata was not changed, but notebook runtime recovery failed (${recoveryFailures.join("; ")}); call notebook with ${JSON.stringify({ input: JSON.stringify({ action: "restart" }) })} before retrying`,
					),
					{ cause: error },
				);
			}
			const reason = error instanceof Error ? error.message : String(error);
			throw new Error(
				`${reason}. Durable pin and hook metadata was not changed${hooksConfigured || rollbackPromotion ? "; transient notebook state was restored" : ""}`,
				{ cause: error },
			);
		}
		const retained = this.host.retainedBindings();
		const reportedNames = withinNameBudget(names);
		const selected = retained.filter((binding) =>
			reportedNames.includes(binding.name),
		);
		const bindings = takeDetailValues(selected, {
			remaining: NOTEBOOK_DETAILS_BUDGET,
		});
		return {
			message: `${pinned ? "Pinned" : "Unpinned"} durable notebook bindings: ${formatNameList(names)}${hook === undefined ? "" : `; hook ${hook || "removed"}`}`,
			details: {
				pinned,
				bindings,
				bindingCount: names.length,
				omittedBindings: names.length - bindings.length,
			},
		};
	}

	private async configureToolHooks(
		names: string[],
		enabled: boolean,
	): Promise<void> {
		const configured = await this.host
			.kernel()!
			.execute(notebookToolHooksSource(names, enabled));
		if (configured.status !== "ok")
			throw new Error(
				`Notebook runtime bootstrap unavailable: __piNotebook.configureToolHooks: ${configured.errorText ?? configured.status}`,
			);
	}
}
