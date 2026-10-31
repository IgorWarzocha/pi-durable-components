import type { Context } from "@earendil-works/chord";
import type { Provider } from "@earendil-works/pi-ai/models";
import type {
	ConversationId,
	Extension,
	Harness,
	InputSubmissionDraft,
	JsonObject,
	Storage,
	SubmissionId,
	TaskId,
} from "@earendil-works/pi-durable";
import type { ComponentCapabilities } from "./capabilities.ts";

export type ComponentRuntime = "node" | "workerd" | "browser";
export type ComponentKind = "extension" | "provider" | "service" | "library";
export type ComponentPermission =
	| "filesystem"
	| "process"
	| "network"
	| "audio"
	| "browser"
	| "models"
	| "storage";

/** Data inside package.json. Reading this must not require importing package code. */
export interface ComponentDescriptor {
	readonly schemaVersion: 1;
	readonly kind: ComponentKind;
	readonly entry?: "./component";
	readonly runtimes: readonly ComponentRuntime[];
	readonly requires: readonly string[];
	/** User-visible trust requirements, not an enforced sandbox policy. */
	readonly permissions: readonly ComponentPermission[];
	/** Overlapping groups are alternatives, not packages to select together. */
	readonly selectionGroup?: string;
}

export interface ComponentPackage {
	readonly name: string;
	readonly version: string;
	readonly description: string;
	readonly peerDependencies: Readonly<Record<string, string>>;
	readonly peerDependenciesMeta: Readonly<
		Record<string, { readonly optional?: boolean }>
	>;
	readonly durable: ComponentDescriptor;
}

export interface ComponentCatalogEntry {
	readonly package: string;
	readonly version: string;
	readonly description: string;
}

export interface ComponentCatalog {
	readonly schemaVersion: 1;
	readonly name: string;
	readonly components: readonly ComponentCatalogEntry[];
}

/** The actual host instances, supplied before stored work can resume. */
export interface ComponentBinding {
	readonly harness: Harness;
	readonly storage: Storage;
}

export interface ComponentRequest {
	readonly capabilities: ComponentCapabilities;
	readonly configuration: JsonObject;
	readonly context: Context;
}

export type ComponentInputPlacement =
	| { readonly status: "submitted"; readonly submissionId: SubmissionId }
	| { readonly status: "aborted"; readonly reason?: string }
	| { readonly status: "failed"; readonly message: string };

/** Accepted work is distinct from native placement and the final answer. */
export interface ComponentInput {
	readonly taskId: TaskId;
	/** Cancelling this observation does not cancel the admitted task. */
	waitForSubmission(context: Context): Promise<ComponentInputPlacement>;
	/** Explicitly cancel only this owned admission, including any placed continuation. */
	abort(context: Context): Promise<"aborted" | "settled">;
}

/** Optional native admission. Original drafts and native receipts remain available. */
export interface ComponentAdmission {
	readonly extensions: readonly string[];
	/** Read-only retry lookup. This must never create work or reopen sealed admission. */
	rejoin?(
		conversationId: ConversationId,
		requestId: string,
		context: Context,
	): Promise<ComponentInput | undefined>;
	submit(
		conversationId: ConversationId,
		input: InputSubmissionDraft,
		context: Context,
	): Promise<ComponentInput>;
}

/**
 * Construction returns registrations without publishing them or starting work.
 * The host owns registry publication, exact selection, scheduling and its idle barrier.
 */
export interface ComponentInstance<Api = unknown> {
	readonly extensions?: readonly Extension[];
	readonly providers?: readonly Provider[];
	readonly api?: Api;
	/** Native kernels and bound task definitions can outlive a package selection. */
	readonly retention?: "idle" | "harness";
	readonly admission?: ComponentAdmission;
	bind?(binding: ComponentBinding, context: Context): void | Promise<void>;
	/** Seal background producers before live retirement observes idle. Never cancel accepted work. */
	stopAdmission?(context: Context): void | Promise<void>;
	/** Explicit shutdown: ingress is sealed; cancel/join owned resources while the Harness still exists. */
	beforeClose?(context: Context): void | Promise<void>;
	/** Releases binding references only after the Harness and its task invocations close. */
	afterClose?(context: Context): void | Promise<void>;
	/** Also called for retained generations, never just the latest installed copy. */
	maintain?(context: Context): unknown | Promise<unknown>;
}

export interface ComponentModule {
	createComponent(
		request: ComponentRequest,
	): ComponentInstance | Promise<ComponentInstance>;
}

export interface ComponentCompatibility {
	readonly runtime: ComponentRuntime;
	readonly peers: Readonly<Record<string, string>>;
	readonly capabilities: ReadonlySet<string>;
}
