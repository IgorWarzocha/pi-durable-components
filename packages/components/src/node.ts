import { archivePackageJson } from "./archive.ts";
import { isCapabilityObject } from "./capabilities.ts";
import type { ComponentCatalogEntry, ComponentPackage } from "./contracts.ts";
import { parseComponentCatalog, parseComponentPackage } from "./metadata.ts";
import {
	approvedTarball,
	byteLimit,
	fetchBytes,
	parseJson,
	registryUrl,
	verifyIntegrity,
} from "./registry.ts";

export interface VerifiedComponentPackage {
	readonly manifest: ComponentPackage;
	readonly source: {
		readonly package: string;
		readonly version: string;
		readonly registry: string;
		readonly tarball: string;
		readonly integrity: string;
		/** Lowercase hexadecimal digest of the compressed archive bytes. */
		readonly sha256: string;
	};
	/** The exact SRI-verified tgz bytes; installation remains the host's decision. */
	readonly archive: Uint8Array;
}

export interface InspectRegistryComponentOptions {
	readonly fetch: typeof globalThis.fetch;
	readonly registry?: string;
	readonly signal?: AbortSignal;
	/** Defaults to 64 MiB. */
	readonly maxArchiveBytes?: number;
	/** Defaults to 256 MiB, including tar headers and padding. */
	readonly maxExpandedBytes?: number;
}

/** Inspect one pinned npm release without installing, importing or executing it. */
export async function inspectRegistryComponent(
	entry: ComponentCatalogEntry,
	options: InspectRegistryComponentOptions,
): Promise<VerifiedComponentPackage> {
	parseComponentCatalog({
		schemaVersion: 1,
		name: "inspection",
		components: [entry],
	});
	const registry = registryUrl(options.registry);
	const maxArchiveBytes = byteLimit(options.maxArchiveBytes, 64 * 1024 * 1024);
	const maxExpandedBytes = byteLimit(
		options.maxExpandedBytes,
		256 * 1024 * 1024,
	);
	const metadataUrl = new URL(
		`${encodeURIComponent(entry.package)}/${encodeURIComponent(entry.version)}`,
		registry,
	);
	const metadata = parseJson(
		await fetchBytes(
			options.fetch,
			metadataUrl,
			2 * 1024 * 1024,
			options.signal,
		),
	);
	if (
		!isCapabilityObject(metadata) ||
		metadata["name"] !== entry.package ||
		metadata["version"] !== entry.version
	)
		throw new Error(
			"Registry metadata identity does not match the pinned catalogue entry",
		);
	const dist = metadata["dist"];
	if (
		!isCapabilityObject(dist) ||
		typeof dist["integrity"] !== "string" ||
		typeof dist["tarball"] !== "string"
	)
		throw new Error(
			"Registry release requires dist.integrity and dist.tarball",
		);
	const tarball = approvedTarball(dist["tarball"], registry);
	const archive = await fetchBytes(
		options.fetch,
		tarball,
		maxArchiveBytes,
		options.signal,
	);
	const sha256 = verifyIntegrity(archive, dist["integrity"]);
	options.signal?.throwIfAborted();
	const manifest = parseComponentPackage(
		archivePackageJson(archive, maxExpandedBytes, options.signal),
	);
	if (manifest.name !== entry.package || manifest.version !== entry.version)
		throw new Error(
			"Verified package identity does not match the pinned catalogue entry",
		);
	options.signal?.throwIfAborted();
	return {
		manifest,
		source: {
			package: manifest.name,
			version: manifest.version,
			registry: registry.href,
			tarball: tarball.href,
			integrity: dist["integrity"],
			sha256,
		},
		archive,
	};
}
