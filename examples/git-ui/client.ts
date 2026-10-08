import {
	type JsonValue,
	mountUi,
	type UiSession,
} from "@howaboua/pi-durable-ui";
import { mountDiff } from "@howaboua/pi-durable-ui/react/diff";

function element<T extends HTMLElement>(
	selector: string,
	constructor: { new (): T },
): T {
	const found = document.querySelector(selector);
	if (!(found instanceof constructor)) throw new Error(`Missing ${selector}`);
	return found;
}
const container = element("#view", HTMLElement);
const status = element("#status", HTMLOutputElement);
const token = document.querySelector<HTMLMetaElement>(
	'meta[name="rpc-token"]',
)?.content;
let session: UiSession | undefined;
let lifetime: AbortController | undefined;
let changing = false;

function report(error: unknown) {
	status.value = error instanceof Error ? error.message : String(error);
}
async function dispose() {
	lifetime?.abort();
	await session?.dispose();
	session = undefined;
	status.value = "Unmounted";
}
async function mount() {
	if (changing) return;
	changing = true;
	try {
		await dispose();
		lifetime = new AbortController();
		const signal = lifetime.signal;
		session = mountUi(mountDiff, container, {
			id: "git",
			revision: "example-1",
			signal,
			async call(method, input): Promise<JsonValue> {
				const response = await fetch("/rpc", {
					method: "POST",
					signal,
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${token}`,
					},
					body: JSON.stringify({ method, input }),
				});
				if (!response.ok) throw new Error(await response.text());
				return response.json();
			},
		});
		void session.closed.catch(report);
		await session.ready;
		status.value = "Mounted";
	} finally {
		changing = false;
	}
}
element("#mount", HTMLButtonElement).addEventListener("click", () => {
	void mount().catch(report);
});
element("#dispose", HTMLButtonElement).addEventListener("click", () => {
	if (!changing) void dispose().catch(report);
});
window.addEventListener(
	"pagehide",
	() => {
		void dispose().catch(report);
	},
	{ once: true },
);
void mount().catch(report);
