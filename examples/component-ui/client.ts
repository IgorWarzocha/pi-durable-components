import {
	notebookCapability,
	notebookDetail,
	notebookSummary,
} from "@howaboua/pi-durable-notebook/presentation";
import {
	bindCapability,
	connectUiBinding,
	mountPresentation,
	type UiCapability,
	type UiCleanup,
	type UiPresentation,
	type UiPresentationContext,
} from "@howaboua/pi-durable-ui";
import {
	reviewCapability,
	reviewDetail,
	reviewSummary,
	type SummaryModel,
} from "./components.ts";
import { httpTransport } from "./transport.ts";
import { mountNotebookDetail, mountReviewDetail } from "./views.ts";

const token = document.querySelector<HTMLMetaElement>(
	'meta[name="rpc-token"]',
)?.content;
const status = document.querySelector<HTMLOutputElement>("#host-status");
const lifecycle = document.querySelector<HTMLButtonElement>("#lifecycle");
if (!token || !status || !lifecycle) throw new Error("Missing host controls");
const rpcToken = token;
const controller = new AbortController();
const cleanups: UiCleanup[] = [];
const report = (error: unknown) => {
	status.value = String(error);
};

// The host chooses renderers and placement, never dispatches on capability names.
function registration<State, Summary>(
	capability: UiCapability<State>,
	summary: UiPresentation<State, Summary>,
	detail: UiPresentation<State, State>,
	mount: (
		container: HTMLElement,
		context: UiPresentationContext<State>,
	) => UiCleanup,
	summaryText: (model: Summary) => SummaryModel,
) {
	return async () => {
		const container = document.getElementById(capability.id);
		if (!container) throw new Error("Missing capability container");
		const connection = await connectUiBinding(
			httpTransport(capability.id, rpcToken),
			{ signal: controller.signal },
		);
		cleanups.push(() => connection.close());
		void connection.closed.catch(report);
		const instance = await bindCapability(capability, {
			id: capability.id,
			signal: controller.signal,
			binding: connection,
		});
		cleanups.push(() => instance.dispose());
		void instance.closed.catch(report);
		const summaryContainer = document.createElement("div");
		const detailContainer = document.createElement("div");
		detailContainer.hidden = true;
		detailContainer.id = capability.id + "-detail";
		const dismiss = document.createElement("button");
		dismiss.textContent = "Dismiss detail";
		dismiss.type = "button";
		const view = document.createElement("div");
		detailContainer.append(dismiss, view);
		container.append(summaryContainer, detailContainer);
		let open: HTMLButtonElement;
		const summarySession = mountPresentation(summary, summaryContainer, {
			instance,
			signal: controller.signal,
			onRequestPresentation: async (id, { signal }) => {
				signal.throwIfAborted();
				if (id !== detail.id)
					throw new Error("Unsupported host presentation: " + id);
				detailContainer.hidden = false;
				open.setAttribute("aria-expanded", "true");
				dismiss.focus();
			},
			mount: (target, context) => {
				const heading = document.createElement("h2");
				const description = document.createElement("p");
				open = document.createElement("button");
				open.type = "button";
				open.textContent = "Open detail";
				open.setAttribute("aria-controls", detailContainer.id);
				open.setAttribute("aria-expanded", "false");
				const render = () => {
					const model = summaryText(context.state.getSnapshot());
					heading.textContent = model.title;
					description.textContent = model.description;
					open.setAttribute("aria-label", "Open " + model.title + " detail");
				};
				const unsubscribe = context.state.subscribe(render);
				render();
				open.addEventListener(
					"click",
					() => {
						void context.requestPresentation(detail.id).catch(report);
					},
					{ signal: context.signal },
				);
				target.append(heading, description, open);
				return () => {
					unsubscribe();
					target.replaceChildren();
				};
			},
		});
		cleanups.push(() => summarySession.dispose());
		void summarySession.closed.catch(report);
		await summarySession.ready;
		const detailSession = mountPresentation(detail, view, {
			instance,
			signal: controller.signal,
			mount,
		});
		cleanups.push(() => detailSession.dispose());
		void detailSession.closed.catch(report);
		await detailSession.ready;
		const hide = () => {
			detailContainer.hidden = true;
			open.setAttribute("aria-expanded", "false");
			open.focus();
		};
		dismiss.addEventListener("click", hide, { signal: controller.signal });
		detailContainer.addEventListener(
			"keydown",
			(event) => {
				if (event.key === "Escape") hide();
			},
			{ signal: controller.signal },
		);
		cleanups.push(() => container.replaceChildren());
	};
}

const registrations = [
	registration(
		notebookCapability,
		notebookSummary,
		notebookDetail,
		mountNotebookDetail,
		(model) => ({
			title: model.title,
			description: model.cell
				? `Cell ${model.cell.id}: ${model.cell.status}${model.isError ? " (error)" : ""}`
				: model.isError
					? "Request failed"
					: model.hasResult
						? "Control result available"
						: "No cell observed",
		}),
	),
	registration(
		reviewCapability,
		reviewSummary,
		reviewDetail,
		mountReviewDetail,
		(model) => model,
	),
];
try {
	for (const register of registrations) await register();
	status.value = "Connected. Open a detail view to work.";
} catch (error) {
	controller.abort();
	await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
	report(error);
}
lifecycle.addEventListener("click", () => {
	lifecycle.disabled = true;
	controller.abort();
	void Promise.all(cleanups.map((cleanup) => cleanup()))
		.then(() => {
			status.value =
				"Unmounted. Host comments and notebook state remain owned by the host.";
		})
		.catch(report);
});
window.addEventListener("pagehide", () => controller.abort(), { once: true });
