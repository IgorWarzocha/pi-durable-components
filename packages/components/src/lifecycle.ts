import type { Context } from "@earendil-works/chord";
import type { Provider } from "@earendil-works/pi-ai/models";
import type { Extension } from "@earendil-works/pi-durable";
import type { ComponentAdmission, ComponentBinding } from "./contracts.ts";
import type { ComponentRegistrations } from "./registrations.ts";
import type {
	ComponentData,
	PrepareComponentsOptions,
	PreparedComponent,
	SkippedComponent,
} from "./runtime.ts";

type Phase =
	| "prepared"
	| "bound"
	| "bind-failed"
	| "retiring"
	| "retired"
	| "closing"
	| "before-closed"
	| "closed";
type Entry = {
	readonly component: PreparedComponent;
	stage: "unbound" | "bound" | "bind-failed" | "before-closed" | "closed";
	admission: "open" | "stopped";
};

/** Owns lifetimes, not registry publication or the host's scheduler. */
export class PreparedComponents {
	readonly extensions: readonly Extension[];
	readonly providers: readonly Provider[];
	readonly instances: readonly PreparedComponent[];
	readonly libraries: readonly ComponentData[];
	readonly skipped: readonly SkippedComponent[];
	private readonly entries: Entry[];
	private readonly available: ReadonlyMap<string, Extension>;
	private phase: Phase = "prepared";
	private binding: ComponentBinding | undefined;
	private tail: Promise<void> = Promise.resolve();
	private readonly whenIdle: PrepareComponentsOptions["whenIdle"];
	private admission: "open" | "retiring" | "shutdown" = "open";
	private interruptRetirement: (() => void) | undefined;

	constructor(
		components: readonly PreparedComponent[],
		libraries: readonly ComponentData[],
		skipped: readonly SkippedComponent[],
		registrations: ComponentRegistrations,
		whenIdle: PrepareComponentsOptions["whenIdle"],
		existing: readonly Extension[],
	) {
		this.whenIdle = whenIdle;
		this.instances = Object.freeze([...components]);
		this.libraries = Object.freeze([...libraries]);
		this.skipped = Object.freeze([...skipped]);
		this.extensions = Object.freeze([...registrations.extensions]);
		this.providers = Object.freeze([...registrations.providers]);
		this.entries = components.map((component) => ({
			component,
			stage: "unbound",
			admission: "open",
		}));
		this.available = new Map(
			[...existing, ...this.extensions].map((extension) => [
				extension.name,
				extension,
			]),
		);
	}

	get status(): Phase {
		return this.phase;
	}

	bind(binding: ComponentBinding, context: Context): Promise<void> {
		return this.serial(async () => {
			if (
				this.phase === "bound" &&
				this.binding?.harness === binding.harness &&
				this.binding.storage === binding.storage
			)
				return;
			if (this.phase !== "prepared")
				throw new Error(`Cannot bind components in state ${this.phase}`);
			this.binding = { ...binding };
			try {
				for (const entry of this.entries) {
					entry.stage = "bind-failed";
					await entry.component.instance.bind?.(binding, context);
					entry.stage = "bound";
				}
				this.phase = "bound";
			} catch (error) {
				this.phase = "bind-failed";
				throw error;
			}
		});
	}

	retire(context: Context): Promise<void> {
		if (this.admission === "open") this.admission = "retiring";
		return this.serial(async () => {
			if (this.phase === "retired" || this.phase === "closed") return;
			if (
				this.admission === "shutdown" ||
				this.phase === "closing" ||
				this.phase === "before-closed"
			)
				throw new Error("Component shutdown already started");
			this.phase = "retiring";
			await this.stopProducerAdmission(context);
			await this.observeRetirementIdle(context);
			const errors: unknown[] = [];
			for (const entry of this.entries) {
				const instance = entry.component.instance;
				if (
					instance.retention === "harness" ||
					instance.afterClose ||
					entry.stage === "closed"
				)
					continue;
				try {
					await instance.beforeClose?.(context);
					entry.stage = "closed";
				} catch (error) {
					errors.push(error);
				}
			}
			if (errors.length)
				throw new AggregateError(
					errors,
					"Component retirement cleanup failed; ownership retained",
				);
			this.phase = "retired";
		});
	}

	closeBeforeHarness(context: Context): Promise<void> {
		// Seal cached admission facades synchronously, including while another lifecycle call runs.
		this.admission = "shutdown";
		this.interruptRetirement?.();
		return this.serial(async () => {
			if (this.phase === "before-closed" || this.phase === "closed") return;
			this.phase = "closing";
			await this.stopProducerAdmission(context);
			// Explicit shutdown must let owners cancel/join cells that prevent the host becoming idle.
			await this.cleanupBefore(context);
			this.phase = "before-closed";
		});
	}

	closeAfterHarness(context: Context): Promise<void> {
		return this.serial(async () => {
			if (this.phase === "closed") return;
			if (this.phase !== "before-closed")
				throw new Error("Run closeBeforeHarness before closeAfterHarness");
			if (this.binding) await this.binding.harness.closed;
			const errors: unknown[] = [];
			for (const entry of [...this.entries].reverse()) {
				if (entry.stage === "closed") continue;
				try {
					await entry.component.instance.afterClose?.(context);
					entry.stage = "closed";
				} catch (error) {
					errors.push(error);
				}
			}
			if (errors.length)
				throw new AggregateError(
					errors,
					"Component after-close cleanup failed; ownership retained",
				);
			this.binding = undefined;
			this.phase = "closed";
		});
	}

	maintain(context: Context): Promise<void> {
		return this.serial(async () => {
			const errors: unknown[] = [];
			for (const entry of this.entries) {
				if (entry.stage === "closed" || entry.stage === "before-closed")
					continue;
				try {
					await entry.component.instance.maintain?.(context);
				} catch (error) {
					errors.push(error);
				}
			}
			if (errors.length)
				throw new AggregateError(errors, "Component maintenance failed");
		});
	}

	assertSelection(selectedExtensionNames: readonly string[]): void {
		const selected = new Set(selectedExtensionNames);
		const tools = new Map<string, string>();
		for (const name of selected) {
			const extension = this.available.get(name);
			if (!extension) throw new Error(`Unknown selected extension: ${name}`);
			for (const tool of extension.tools ?? []) {
				const prior = tools.get(tool.name);
				if (prior)
					throw new Error(
						`Selected tool collision ${tool.name}: ${prior} and ${name}`,
					);
				tools.set(tool.name, name);
			}
		}
		const groups = new Map<string, string>();
		for (const { manifest, instance, id } of this.instances) {
			const group = manifest.durable.selectionGroup;
			if (
				!group ||
				!instance.extensions?.some((extension) => selected.has(extension.name))
			)
				continue;
			const prior = groups.get(group);
			if (prior)
				throw new Error(
					`Select one component from group ${group}: ${prior} and ${id}`,
				);
			groups.set(group, id);
		}
	}

	admissionFor(
		selectedExtensionNames: readonly string[],
	): ComponentAdmission | undefined {
		if (
			!this.binding ||
			this.phase === "closed" ||
			this.phase === "bind-failed"
		)
			throw new Error(
				`Cannot access component admission in state ${this.phase}`,
			);
		this.assertSelection(selectedExtensionNames);
		const selected = new Set(selectedExtensionNames);
		const handlers = this.entries.flatMap((entry) =>
			entry.stage !== "closed" &&
			entry.component.instance.admission?.extensions.some((name) =>
				selected.has(name),
			)
				? [{ entry, handler: entry.component.instance.admission }]
				: [],
		);
		if (handlers.length > 1)
			throw new Error("Multiple selected component admission handlers");
		const active = handlers[0];
		if (!active) return undefined;
		const { entry, handler } = active;
		const rejoin = handler.rejoin;
		return {
			extensions: handler.extensions,
			submit: async (conversationId, input, context) => {
				if (this.admission !== "open" || this.phase !== "bound")
					throw new Error(
						`Cannot admit input in state ${this.phase}/${this.admission}`,
					);
				return handler.submit(conversationId, input, context);
			},
			...(rejoin
				? {
						rejoin: async (conversationId, requestId, context) => {
							if (
								!this.binding ||
								this.phase === "closed" ||
								entry.stage === "closed"
							)
								throw new Error(
									"Cannot rejoin input after its component binding was released",
								);
							return rejoin.call(handler, conversationId, requestId, context);
						},
					}
				: {}),
		};
	}

	/** @internal Failed construction has no Harness and no admitted work to drain. */
	discardUnbound(context: Context): Promise<void> {
		this.admission = "shutdown";
		return this.serial(async () => {
			if (this.binding) throw new Error("Cannot discard bound components");
			if (this.phase === "closed") return;
			this.phase = "closing";
			await this.stopProducerAdmission(context);
			const errors: unknown[] = [];
			for (const entry of [...this.entries].reverse()) {
				if (entry.stage === "closed") continue;
				try {
					if (entry.stage !== "before-closed") {
						await entry.component.instance.beforeClose?.(context);
						entry.stage = "before-closed";
					}
					await entry.component.instance.afterClose?.(context);
					entry.stage = "closed";
				} catch (error) {
					errors.push(error);
				}
			}
			if (errors.length)
				throw new AggregateError(
					errors,
					"Unbound component cleanup failed; ownership retained",
				);
			this.phase = "closed";
		});
	}

	private serial(operation: () => Promise<void>): Promise<void> {
		const result = this.tail.then(operation);
		// A rejected operation stays visible to its caller without poisoning later cleanup retries.
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async observeRetirementIdle(context: Context): Promise<void> {
		if (this.admission === "shutdown")
			throw new Error(
				"Retirement observation interrupted by component shutdown",
			);
		const interrupted = new Promise<never>((_resolve, reject) => {
			this.interruptRetirement = () =>
				reject(
					new Error("Retirement observation interrupted by component shutdown"),
				);
		});
		try {
			// Interrupt only this observation, never the admitted work observed by whenIdle.
			await Promise.race([this.whenIdle(context), interrupted]);
		} finally {
			this.interruptRetirement = undefined;
		}
	}

	private async stopProducerAdmission(context: Context): Promise<void> {
		const errors: unknown[] = [];
		for (const entry of this.entries) {
			if (entry.admission === "stopped" || entry.stage === "closed") continue;
			try {
				await entry.component.instance.stopAdmission?.(context);
				entry.admission = "stopped";
			} catch (error) {
				errors.push(error);
			}
		}
		if (errors.length)
			throw new AggregateError(
				errors,
				"Component admission stop failed; ownership retained",
			);
	}

	private async cleanupBefore(context: Context): Promise<void> {
		const errors: unknown[] = [];
		for (const entry of [...this.entries].reverse()) {
			if (entry.stage === "closed" || entry.stage === "before-closed") continue;
			try {
				await entry.component.instance.beforeClose?.(context);
				entry.stage = "before-closed";
			} catch (error) {
				errors.push(error);
			}
		}
		if (errors.length)
			throw new AggregateError(
				errors,
				"Component before-close cleanup failed; ownership retained",
			);
	}
}
