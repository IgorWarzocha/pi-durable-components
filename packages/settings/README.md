# Settings

Component-owned preferences with global and project overrides. Components validate their own fields and resolve defaults, global overrides, then project overrides. Hosts choose the storage and render the controls.

The core package has no filesystem dependency. The `/node` entry provides JSON persistence for Node 22.19 or later.

```sh
npm install https://github.com/IgorWarzocha/pi-durable-components/releases/download/v0.9.0/howaboua-pi-durable-settings-0.9.0.tgz
```

## Connect a component

Supply absolute roots explicitly. The store does not discover a home directory, walk project ancestors or read Pi's native settings.

```ts
import { createNodeSettingsStorage } from "@howaboua/pi-durable-settings/node";

const storage = createNodeSettingsStorage({
  id: "howaboua.grok-voice",
  globalRoot: "/home/alice/.pi/durable-components",
  projectRoot: "/work/my-project/.pi/durable-components",
});

// Pass this to the component's options.preferences.
const preferences = { storage, writeScope: "project" as const };
```

Grok Voice and GipPity Voice expose a `settingsContribution` when configured with preferences. Read it to obtain defaults, both overrides, source paths, effective settings and a revision. Save a partial override using that revision:

```ts
const current = await component.settingsContribution.read();
const change = await component.settingsContribution.replaceOverride({
  scope: "project",
  value: { voice: "ara" }, // Fields belong to the component.
  expectedRevision: current.revision,
});
console.log(change.application);
```

`replaceOverride` replaces the selected scope's entire override. Pass `null` to remove it and restore inheritance. An unavailable project scope has a `null` source path. A missing file has a source path but a `null` override.

The returned application status is `applied`, `next-use`, `restart-required` or `failed`. A failed application still means the settings were saved. Voice components report `next-use` because active calls keep their starting configuration.

## Persistence and recovery

The Node store writes `<root>/<component-id>.json` as a plain partial JSON object. Each file is limited to 256 KiB. Roots are trusted host-granted directories. Do not use this store for credentials or secrets.

Cooperating processes use locks across both scopes and atomic file replacement. A stale revision fails with `conflict`. Reload and let the user reconcile the changes rather than retrying blindly. Invalid JSON and component validation errors remain visible.

Locks time out after five seconds with `busy`. If a process crashed while holding a lock, confirm that no writer is running before removing the reported `.lock` directory. Locks are never stolen automatically. External text editors do not participate in the compare-and-swap guarantee.

Cancellation before a commit prevents the write. Once a commit starts, cancellation cannot imply that nothing changed. A filesystem failure after replacement reports the uncertain durability and instructs the caller to reload before retrying.

## Define settings

Use `createSettingsContribution` from the core package with a `SettingsDefinition`, a `SettingsStorage` and an optional live `apply` callback. The definition owns strict partial validation and merge semantics. Validation must not fill defaults into persisted overrides. The service validates the complete candidate before saving and calls `apply` only after persistence. Without an application callback, saves report `restart-required`.

Hosts may provide other storage implementations through the same interface. They must atomically compare the supplied revision and replace the selected override among their writers. No generic form schema, secret storage or native Durable harness configuration is implied.
