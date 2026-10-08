import type {
	JsonValue,
	UiCleanup,
	UiPresentationContext,
} from "@howaboua/pi-durable-ui";
import type { ReviewState } from "./components.ts";

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

export function mountReviewDetail(
	container: HTMLElement,
	context: UiPresentationContext<ReviewState>,
): UiCleanup {
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
}
