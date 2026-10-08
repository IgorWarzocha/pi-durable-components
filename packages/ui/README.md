# UI SDK

Trusted browser UI mounts, scoped theme tokens and a composable Git diff renderer. The root entry has no React or Durable runtime import.

```ts
import { mountUi } from "@howaboua/pi-durable-ui";
import { mountDiff } from "@howaboua/pi-durable-ui/react/diff";

const session = mountUi(mountDiff, container, {
  id: "git", revision: "1", signal: lifetime.signal,
  call: (method, input) => hostRpc(method, input),
});
await session.ready;
session.closed.catch(reportError);
// On teardown:
await session.dispose();
```

Mounts receive `{ id, revision, signal, call }` and must return a cleanup function. `mountUi` owns a child signal and invokes cleanup exactly once, even if an asynchronous mount finishes after disposal. Observe `ready` for mounting errors and `closed` for automatic cleanup errors. `dispose` aborts and waits for cleanup. A mount that fails before returning must release its own partial resources. A mount that ignores cancellation can delay disposal.

The host owns authentication, revision selection, module loading, authorization and transport. `call` carries one JSON request and response. Abort prevents new calls and rejects stale responses. It does **not** cancel remote IO or undo remote side effects. This is trusted in-process code, not a sandbox.

## Diff rendering

Install React and React DOM 19.3.0 and `@pierre/diffs` 1.4.3 for `/react/diff`. These are optional peers, not dependencies of the generic mount API.

`DiffCodeView` preserves Pierre's generic props, imperative ref, controlled or initial items, annotation and header slots, editing provider, selection and full-file loading callbacks. `createDiffOptions` supplies shared defaults without taking ownership of host state. `parseDiffPatch` returns Pierre files, leaving ordering and fallback presentation to the host. `DiffWorkerProvider` takes a bundler-owned `workerFactory`, uses two to six workers, and keeps resource management in Pierre's provider. Hosts can supply their existing editing provider around the viewer.

`mountDiff` is an independent read-only view with loading, error and empty states and unified or split layout. It calls `git.diff` with `{}`. The host resolves the repository and returns `GitDiffResult` from the same Git reader used by agent tools. It does not replace a host's richer edit, review or image-preview interface.

`themeCss` scopes tokens to `[data-durable-ui]`: `--durable-ui-background`, `foreground`, `muted`, `border` and `accent`. It follows the system theme or a `data-theme="light"` or `"dark"` override. Hosts can override these variables for their own palette. No global page styles or font are installed.

See `examples/git-ui` in the component repository for a host with no Howcode dependency. These new packages currently use local development artifacts. Publishing and consumer release packaging are separate work.
