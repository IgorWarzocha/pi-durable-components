import {
	connectUiBinding,
	mountComponent,
	type UiComponent,
	type UiConnection,
	type UiSession,
} from "@howaboua/pi-durable-ui";
import { notebookComponent, reviewComponent } from "./components.ts";
import { httpTransport } from "./transport.ts";

const token = document.querySelector<HTMLMetaElement>(
	'meta[name="rpc-token"]',
)?.content;
const status = document.querySelector<HTMLOutputElement>("#host-status");
const lifecycle = document.querySelector<HTMLButtonElement>("#lifecycle");
if (!token || !status || !lifecycle) throw new Error("Missing host controls");
const controller = new AbortController();
const sessions: UiSession[] = [];
const connections: UiConnection[] = [];
const components: readonly UiComponent<unknown>[] = [
	notebookComponent,
	reviewComponent,
];
try {
	for (const component of components) {
		const container = document.getElementById(component.id);
		if (!container) throw new Error("Missing component container");
		const connection = await connectUiBinding(
			httpTransport(component.id, token),
			{ signal: controller.signal },
		);
		connections.push(connection);
		void connection.closed.catch((error: unknown) => {
			status.value = String(error);
		});
		const session = mountComponent(component, container, {
			id: component.id,
			signal: controller.signal,
			binding: connection,
		});
		sessions.push(session);
		void session.closed.catch((error: unknown) => {
			status.value = String(error);
		});
		await session.ready;
	}
	status.value = "Connected";
} catch (error) {
	controller.abort();
	status.value = String(error);
}
lifecycle.addEventListener("click", () => {
	lifecycle.disabled = true;
	controller.abort();
	void Promise.all([
		...sessions.map((session) => session.dispose()),
		...connections.map((connection) => connection.close()),
	])
		.then(() => {
			status.value =
				"Unmounted. Host comments and notebook state remain owned by the host.";
		})
		.catch((error: unknown) => {
			status.value = String(error);
		});
});
window.addEventListener("pagehide", () => controller.abort(), { once: true });
