import {
	type GitDiffResult,
	parseGitDiffResult,
} from "@howaboua/pi-durable-git/contracts";
import { type FileDiffMetadata, parsePatchFiles } from "@pierre/diffs";
import {
	CodeView,
	type CodeViewHandle,
	type CodeViewProps,
	type CodeViewReactOptions,
	WorkerPoolContextProvider,
} from "@pierre/diffs/react";
import { type ReactNode, type Ref, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { UiContext, UiMount } from "../index.ts";
import { themeCss } from "../theme.ts";

export const diffThemes = {
	light: "pierre-light",
	dark: "pierre-dark",
} as const;

/** Shared viewer defaults, not host editing, annotation, selection, or hydration state. */
export function createDiffOptions<Annotation = undefined, Caret = undefined>(
	overrides: CodeViewReactOptions<Annotation, Caret> = {},
): CodeViewReactOptions<Annotation, Caret> {
	return {
		diffStyle: "unified",
		lineDiffType: "none",
		overflow: "wrap",
		theme: diffThemes,
		themeType: "system",
		lineHoverHighlight: "both",
		itemMetrics: {
			lineHeight: 20,
			diffHeaderHeight: 36,
			hunkSeparatorHeight: 8,
		},
		layout: { gap: 8, paddingTop: 0, paddingBottom: 8 },
		...overrides,
	};
}

export function DiffCodeView<Annotation = undefined, Caret = undefined>(
	props: CodeViewProps<Annotation, Caret> & {
		ref?: Ref<CodeViewHandle<Annotation, Caret>>;
	},
) {
	const options = useMemo(
		() => createDiffOptions(props.options),
		[props.options],
	);
	return <CodeView {...props} options={options} />;
}

/** Supply a bundler-owned worker factory. No fixed asset URLs or worker startup at import. */
export function DiffWorkerProvider({
	workerFactory,
	children,
}: {
	workerFactory: () => Worker;
	children: ReactNode;
}) {
	const poolOptions = useMemo(
		() => ({
			workerFactory,
			poolSize: Math.max(
				2,
				Math.min(
					6,
					Math.floor(
						(typeof navigator === "undefined"
							? 4
							: navigator.hardwareConcurrency || 4) / 2,
					),
				),
			),
			totalASTLRUCacheSize: 100,
		}),
		[workerFactory],
	);
	return (
		<WorkerPoolContextProvider
			poolOptions={poolOptions}
			highlighterOptions={{ theme: diffThemes, tokenizeMaxLineLength: 1000 }}
		>
			{children}
		</WorkerPoolContextProvider>
	);
}

export function parseDiffPatch(
	patch: string,
	cacheKey?: string,
): FileDiffMetadata[] {
	if (!patch.trim()) return [];
	const files = parsePatchFiles(patch.trim(), cacheKey).flatMap(
		(parsed) => parsed.files,
	);
	return files;
}

type DiffState =
	| { kind: "loading" }
	| { kind: "error"; message: string }
	| { kind: "ready"; result: GitDiffResult; files: FileDiffMetadata[] };

function DiffPanel({ context }: { context: UiContext }) {
	const [state, setState] = useState<DiffState>({ kind: "loading" });
	const [style, setStyle] = useState<"unified" | "split">("unified");
	useEffect(() => {
		const lifetime = new AbortController();
		const signal = AbortSignal.any([lifetime.signal, context.signal]);
		void context
			.call("git.diff", {})
			.then(parseGitDiffResult)
			.then((result) => {
				signal.throwIfAborted();
				setState({ kind: "ready", result, files: parseDiffPatch(result.diff) });
			})
			.catch((error: unknown) => {
				if (!signal.aborted)
					setState({
						kind: "error",
						message: error instanceof Error ? error.message : String(error),
					});
			});
		return () => lifetime.abort();
	}, [context]);
	const files = state.kind === "ready" ? state.files : undefined;
	const items = useMemo(
		() =>
			files?.map((fileDiff, index) => ({
				type: "diff" as const,
				id: `${index}:${fileDiff.name}`,
				fileDiff,
			})),
		[files],
	);
	return (
		<section
			data-durable-ui=""
			aria-label="Git diff"
			style={{
				display: "flex",
				flexDirection: "column",
				height: "100%",
				minHeight: 0,
				font: "14px/1.5 system-ui, sans-serif",
			}}
		>
			<style>{themeCss}</style>
			<header
				style={{
					padding: "12px 16px",
					borderBottom: "1px solid var(--durable-ui-border)",
					display: "flex",
					flexWrap: "wrap",
					gap: 16,
					alignItems: "center",
				}}
			>
				<h2 style={{ margin: 0, fontSize: 16 }}>Changes</h2>
				{state.kind === "ready" && (
					<span>
						{state.result.fileCount} files, +{state.result.insertions} −
						{state.result.deletions}
					</span>
				)}
				<label style={{ marginLeft: "auto" }}>
					Layout{" "}
					<select
						value={style}
						onChange={(event) =>
							setStyle(event.target.value === "split" ? "split" : "unified")
						}
					>
						<option value="unified">Unified</option>
						<option value="split">Split</option>
					</select>
				</label>
			</header>
			{state.kind === "loading" && <p role="status">Loading changes</p>}
			{state.kind === "error" && <p role="alert">{state.message}</p>}
			{state.kind === "ready" &&
				(items?.length ? (
					<DiffCodeView
						items={items}
						options={{ diffStyle: style }}
						style={{ flex: 1, minHeight: 0 }}
					/>
				) : state.result.diff.trim() ? (
					<div style={{ overflow: "auto" }}>
						<p>Unsupported diff format. Showing the raw patch.</p>
						<pre>{state.result.diff}</pre>
					</div>
				) : (
					<p>No changes.</p>
				))}
		</section>
	);
}

/** Standalone trusted-package mount. The host resolves and authorizes git.diff's repository. */
export const mountDiff: UiMount = (container, context) => {
	context.signal.throwIfAborted();
	const root = createRoot(container);
	root.render(<DiffPanel context={context} />);
	return () => root.unmount();
};
