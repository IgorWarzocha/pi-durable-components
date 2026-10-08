import type { JsonValue, UiComponent } from "@howaboua/pi-durable-ui";

function object(value: JsonValue): { readonly [key: string]: JsonValue } {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Expected state object");
	return value as { readonly [key: string]: JsonValue };
}
function string(value: JsonValue | undefined): string {
	if (typeof value !== "string") throw new Error("Expected string");
	return value;
}
function required<T extends Element>(
	container: HTMLElement,
	selector: string,
	type: { new (...args: never[]): T },
): T {
	const element = container.querySelector(selector);
	if (!(element instanceof type)) throw new Error(`Missing ${selector}`);
	return element;
}

interface NotebookState {
	status: string;
	result: JsonValue;
}
export const notebookComponent: UiComponent<NotebookState> = {
	id: "notebook",
	version: 1,
	actions: ["exec", "wait", "notebook"],
	streams: ["results"],
	parseState(value) {
		const state = object(value);
		return { status: string(state["status"]), result: state["result"] ?? null };
	},
	mount(container, context) {
		container.innerHTML = `<h2>Notebook</h2><p>TypeScript runs in real Deno. Globals persist within this host conversation.</p><form><label>Source<textarea name="code" spellcheck="false">var count = (typeof count === "undefined" ? 0 : count) + 1; text({count});</textarea></label><button type="submit">Run</button><button type="button" data-cancel>Cancel request</button><label>Yielded cell ID<input name="cell" autocomplete="off"></label><button type="button" data-wait>Wait</button><button type="button" data-stop>Terminate cell</button><button type="button" data-state>Inspect state</button></form><output aria-live="polite"></output><pre data-result></pre><details><summary>Live result stream</summary><pre data-stream></pre></details>`;
		const form = required(container, "form", HTMLFormElement);
		const code = required(container, "textarea", HTMLTextAreaElement);
		const cell = required(container, "input", HTMLInputElement);
		const status = required(container, "output", HTMLOutputElement);
		const result = required(container, "[data-result]", HTMLPreElement);
		const journal = required(container, "[data-stream]", HTMLPreElement);
		let active: AbortController | undefined;
		const render = () => {
			const state = context.state.getSnapshot();
			status.value = state.status;
			result.textContent = JSON.stringify(state.result, null, 2);
			if (
				state.result &&
				typeof state.result === "object" &&
				!Array.isArray(state.result)
			) {
				const details = object(state.result)["details"];
				if (details && typeof details === "object" && !Array.isArray(details)) {
					const id = object(details)["cell_id"];
					if (typeof id === "string") cell.value = id;
				}
			}
		};
		const unsubscribe = context.state.subscribe(render);
		render();
		const run = async (action: string, input: JsonValue) => {
			if (active) return;
			active = new AbortController();
			try {
				await context.call(action, input, { signal: active.signal });
			} catch (error) {
				if (!context.signal.aborted)
					status.value = active.signal.aborted
						? "Cancellation requested for this Notebook conversation, including yielded cells. The host publishes completion after joining them. Side effects were not rolled back."
						: String(error);
			} finally {
				active = undefined;
			}
		};
		form.addEventListener(
			"submit",
			(event) => {
				event.preventDefault();
				void run("exec", { code: code.value });
			},
			{ signal: context.signal },
		);
		required(container, "[data-wait]", HTMLButtonElement).addEventListener(
			"click",
			() => {
				void run("wait", { cell_id: cell.value, yield_time_ms: 1000 });
			},
			{ signal: context.signal },
		);
		required(container, "[data-stop]", HTMLButtonElement).addEventListener(
			"click",
			() => {
				void run("wait", { cell_id: cell.value, terminate: true });
			},
			{ signal: context.signal },
		);
		required(container, "[data-state]", HTMLButtonElement).addEventListener(
			"click",
			() => {
				void run("notebook", { input: '{"action":"status"}' });
			},
			{ signal: context.signal },
		);
		required(container, "[data-cancel]", HTMLButtonElement).addEventListener(
			"click",
			() => active?.abort(),
			{ signal: context.signal },
		);
		const stream = (async () => {
			try {
				for await (const value of context.stream("results", null))
					journal.textContent =
						`${JSON.stringify(value, null, 2)}\n${journal.textContent ?? ""}`.slice(
							0,
							20000,
						);
			} catch (error) {
				if (!context.signal.aborted) journal.textContent = String(error);
			}
		})();
		return async () => {
			active?.abort();
			unsubscribe();
			await stream;
			container.replaceChildren();
		};
	},
};

interface Anchor {
	path: string;
	side: string;
	line: number;
	text: string;
}
interface ReviewState {
	revision: string;
	diff: string;
	anchors: Anchor[];
	comments: JsonValue[];
}
export const reviewComponent: UiComponent<ReviewState> = {
	id: "review",
	version: 1,
	actions: ["refresh", "comment"],
	streams: [],
	parseState(value) {
		const state = object(value);
		const list = state["anchors"];
		const comments = state["comments"];
		if (!Array.isArray(list) || !Array.isArray(comments))
			throw new Error("Invalid review state");
		return {
			revision: string(state["revision"]),
			diff: string(state["diff"]),
			comments,
			anchors: list.map((value) => {
				const anchor = object(value);
				const line = anchor["line"];
				const side = string(anchor["side"]);
				if (
					typeof line !== "number" ||
					!Number.isSafeInteger(line) ||
					line < 1 ||
					!["old", "new"].includes(side)
				)
					throw new Error("Invalid anchor");
				return {
					path: string(anchor["path"]),
					side,
					line,
					text: string(anchor["text"]),
				};
			}),
		};
	},
	mount(container, context) {
		container.innerHTML = `<h2>Git review</h2><button type="button" data-refresh>Refresh diff</button><pre data-diff></pre><form><label>Diff line<select aria-label="Comment anchor"></select></label><label>Comment<textarea required maxlength="8000"></textarea></label><button type="submit">Save comment</button></form><output aria-live="polite"></output><h3>Saved comments</h3><div data-comments></div>`;
		const diff = required(container, "[data-diff]", HTMLPreElement);
		const select = required(container, "select", HTMLSelectElement);
		const body = required(container, "textarea", HTMLTextAreaElement);
		const status = required(container, "output", HTMLOutputElement);
		const comments = required(container, "[data-comments]", HTMLDivElement);
		let revision = "";
		const render = () => {
			const state = context.state.getSnapshot();
			diff.textContent =
				state.diff || "No changes. Edit a file in the workspace, then refresh.";
			if (revision !== state.revision) {
				revision = state.revision;
				select.replaceChildren(
					...state.anchors.map(
						(anchor, index) =>
							new Option(
								`${anchor.path} · ${anchor.side}:${anchor.line} ${anchor.text}`,
								String(index),
							),
					),
				);
			}
			comments.replaceChildren(
				...state.comments.map((value) => {
					const comment = object(value);
					const item = document.createElement("p");
					item.textContent = `${string(comment["path"])} · ${string(comment["side"])}:${comment["line"]} ${comment["revision"] === state.revision ? "" : "[earlier revision]"}\n${string(comment["body"])}`;
					item.style.whiteSpace = "pre-wrap";
					return item;
				}),
			);
		};
		const unsubscribe = context.state.subscribe(render);
		render();
		let pending = false;
		const run = async (action: string, input: JsonValue) => {
			if (pending) return;
			pending = true;
			try {
				await context.call(action, input);
				if (!context.signal.aborted) {
					status.value =
						action === "comment" ? "Comment saved" : "Diff refreshed";
					if (action === "comment") body.value = "";
				}
			} catch (error) {
				if (!context.signal.aborted)
					status.value = `${String(error)}. If disconnected during saving, inspect saved comments before submitting again.`;
			} finally {
				pending = false;
			}
		};
		required(container, "[data-refresh]", HTMLButtonElement).addEventListener(
			"click",
			() => {
				void run("refresh", null);
			},
			{ signal: context.signal },
		);
		required(container, "form", HTMLFormElement).addEventListener(
			"submit",
			(event) => {
				event.preventDefault();
				const state = context.state.getSnapshot();
				const anchor = state.anchors[Number(select.value)];
				if (!anchor) {
					status.value = "Select a displayed diff line first";
					return;
				}
				void run("comment", {
					revision: state.revision,
					path: anchor.path,
					side: anchor.side,
					line: anchor.line,
					body: body.value,
				});
			},
			{ signal: context.signal },
		);
		return () => {
			unsubscribe();
			container.replaceChildren();
		};
	},
};
