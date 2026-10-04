# Durable Browser

Control an authenticated Chrome or Chromium browser through an ordinary Pi Durable tool registration. The browser keeps your existing login session. No Pi TUI or Code/Notebook adapter is required.

Requires Node 22.19 or newer and a browser with remote debugging enabled. The host explicitly authorizes native CDP connections, browser launch, SSH processes and a private state directory. Browser actions can change real accounts.

## Install and register

Not yet published to npm. [Build and install from source](../../README.md#build-and-install).

Use the package with Pi Durable, pi-ai and Chord 1.0.2:

```ts
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRegistry } from "@earendil-works/pi-durable";
import { createBrowserExtension, nodeArtifactStore } from "@howaboua/pi-durable-browser";

const stateDirectory = join(tmpdir(), "my-agent-browser");
const browser = createBrowserExtension({
  stateDirectory,
  artifacts: nodeArtifactStore(join(stateDirectory, "artifacts")),
});
const registry = createRegistry();
registry.install(browser.extension);
// Select the browser extension for the conversation in your Durable host.
// At host shutdown, after stopping new calls:
await browser.close();
```

The registered tool accepts `{command: "help"}` or a JSON request string. Start with help. For example, `{command: '{"action":"tabs"}'}` lists tab references. Keep each result's tab reference, element IDs and continuation cursors together.

## Files and lifetime

When Durable supplies `api.env`, screenshots and text continuation files use that environment's `.pi/browser` directory. Set `environmentArtifactDirectory` to change that path. Errors from the environment are reported, not redirected to the host filesystem. Without `api.env`, the explicitly supplied artifact store owns those files. Hosts may provide their own `BrowserArtifactStore`.

Private tab-ownership records and temporary SCP staging always use the configured native `stateDirectory`. Staging files are removed after transfer. Native CDP discovery may read local browser port files. The browser endpoint is independent of the conversation filesystem. To target a container or a different endpoint, supply `discover(signal)` and optionally `start(signal)` in the host config. Omitted callbacks use local discovery and launch.

CDP connections are reused by Durable conversation ID. Idle connections retire after 20 minutes. `stop` detaches automation without closing tabs. Host `close()` cancels and joins owned work. It does not close Chrome or its tabs. Connections do not survive process restart, but saved ownership survives reconnect while the browser endpoint and native state remain. A restarted browser makes restored tabs shared again.

Interrupted browser mutations may already have succeeded. The tool is replay-unsafe. Inspect the browser before repeating a consequential action.

## Local discovery and SSH hosts

Local discovery uses `CDP_HOST` and `CDP_PORT`, defaulting to `127.0.0.1:9222`, then supported `DevToolsActivePort` locations. `CDP_PORT_FILE` supplies a custom port file. The `start` action can launch Chromium through a Linux systemd user session. `CDP_BROWSER`, `CDP_PROFILE_DIRECTORY`, `CDP_SYSTEMCTL` and `CDP_SYSTEMD_RUN` configure that native launch.

For SSH routing, pass `routes: parseBrowserRoutes({hosts: ["workstation", "laptop"], aliases: {"current-machine": "workstation"}, remoteNodePath: "node"}, "current-machine")`. Names must be SSH aliases already configured by the host. Routing is disabled unless configured. Use `host` on every follow-up call using remote references or continuation handles.

Remote hosts need Node, SSH access and their own CDP browser. The shipped worker deploys atomically to `~/.cache/pi-durable-browser/worker.mjs`, refusing to replace an unowned file. Its private socket daemon reuses connections and retires after 20 minutes. Worker sockets and artifacts use `pi-durable-browser` under the remote XDG runtime directory, or a user-scoped temporary directory. These paths and the deployment marker are distinct from Pi Browser's installed helper and state. Screenshots return through SCP into the invocation's artifact store, then the remote screenshot is removed. Text continuation handles stay on the selected remote host.

The CDP implementation derives from [pasky/chrome-cdp-skill](https://github.com/pasky/chrome-cdp-skill) and [pi-browser](https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/b2006db9def12c373ae48e70044d30f7d6b7e34f/packages/pi-browser). See `NOTICE` for attribution.
