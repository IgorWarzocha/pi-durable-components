# UI SDK

Interactive browser components backed by host-owned state, actions and streams. The root entry has no React, Git or Durable runtime import. Components run as trusted in-process code, not in a sandbox.

## Interactive components

### Headless capabilities and presentations

`UiCapability<State>` declares `id`, contract `version`, `parseState`, `actions`, `streams` and supported `presentations`. It has no renderer. `await bindCapability(capability, { id, signal, binding })` creates one instance with one binding subscription. The instance exposes its `capability` definition, `context`, `closed`, `dispose()` and `present()`.

`UiPresentation<State, Model>` declares an `id`, a semantic `select(state)` projection and allowed presentation `requests`. Different presentations share the same capability without reacquiring its binding or replaying work.

```ts
const instance = await bindCapability(counterCapability, {
  id: "counter-instance", signal: lifetime.signal, binding,
});
const summary = instance.present(counterSummary, {
  signal: viewLifetime.signal,
  onRequestPresentation: async (id, { signal }) => {
    await host.openPresentation(id, { signal });
  },
});
await summary.ready;
summary.closed.catch(reportError);
// Framework-neutral store, suitable for React useSyncExternalStore:
const model = summary.context.state.getSnapshot();
await summary.context.requestPresentation("detail");
await summary.dispose();
await instance.dispose();
```

Presentation contexts expose model state, capability actions and streams, and `requestPresentation(id)`. Model snapshots stay referentially stable between accepted source sequences, even when `parseState` reuses an object. A requested target must appear in both the presentation's `requests` and the capability's `presentations`. The host callback owns acquisition, placement and navigation. Requests without a callback reject. Late callback results reject after view cancellation.

Disposing a presentation cancels its work without disposing the shared capability. A projection failure closes only the affected view. Invalid source state closes the capability and all its children. Capability disposal joins child cleanup, including optional renderers. Observe each view's `closed` promise for failures.

`mountPresentation(presentation, container, { instance, signal, onRequestPresentation, mount })` is an optional DOM wrapper. Its `mount(container, context)` receives the same model context and must return a cleanup function. The returned `UiSession` owns the renderer and its presentation, not the shared capability. Headless consumers need no DOM or framework imports. Existing `mountComponent` and `mountUi` remain available.

### Mounted components

A `UiComponent<State>` declares `id`, contract `version`, `parseState`, `mount`, and the allowed `actions` and `streams`. `parseState` validates each accepted JSON snapshot and returns the component's state. `mount` receives a container and `UiComponentContext<State>` and returns a cleanup function, synchronously or asynchronously.

```ts
import { mountComponent, type UiBinding, type UiComponent } from "@howaboua/pi-durable-ui";

const counter: UiComponent<number> = {
  id: "counter",
  version: 1,
  actions: ["increment"],
  streams: [],
  parseState(value) {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      throw new TypeError("Expected an integer counter");
    }
    return value;
  },
  mount(container, context) {
    const button = document.createElement("button");
    const render = () => { button.textContent = String(context.state.getSnapshot()); };
    const increment = () => { void context.call("increment", null).catch(reportError); };
    const unsubscribe = context.state.subscribe(render);
    button.addEventListener("click", increment);
    container.append(button);
    render();
    return () => {
      unsubscribe();
      button.removeEventListener("click", increment);
      button.remove();
    };
  },
};

// The host implements this binding and authorizes each action.
declare const binding: UiBinding;
const session = mountComponent(counter, container, {
  id: "counter-instance", signal: lifetime.signal, binding,
});
session.closed.catch(reportError);
await session.ready;
// On teardown:
await session.dispose();
```

The host binding supplies `getSnapshot()`, `subscribe(onSnapshot, onError)`, `call(action, input, { signal })` and optional `stream(name, input, { signal })`. A snapshot is `{ sequence, value }`. Its sequence must be a nonnegative safe integer that increases within the binding's lifetime. Equal and older snapshots are ignored. The SDK subscribes before reading the initial snapshot, so a newer synchronous publication cannot be overwritten by an older initial read. Accepted values pass through `parseState` before state subscribers are notified. Keep parsed state immutable for stable snapshot reads.

The mount context exposes `id`, `signal`, `state.getSnapshot()`, `state.subscribe(listener)`, `call(action, input)` and `stream(name, input)`. The instance `id` is separate from the component definition's `id`. `version` identifies the component contract, not a state revision. The host owns discovery, contract compatibility, component loading and placement. No layout or transport is imposed.

For remote state, `await connectUiBinding(transport, { signal })` hydrates a `UiConnection` before mounting. The host-neutral `UiTransport` supplies `snapshots({ signal })`, `call` and optional `stream`. Its snapshot stream must establish the subscription before yielding the initial value, then publish updates on that same stream. This preserves updates received between hydration and mounting. A disconnect fails the binding. Observe `connection.closed` for disconnect and automatic cleanup errors. The SDK never reconnects or replays actions. After disposing the component, `await connection.close()` aborts transport work and joins the snapshot reader. It rejects an existing transport failure. The host chooses the wire protocol, authentication and authorization.

Actions and streams must appear in the component's declarations. A declared stream still requires host stream support. Consume streams with `for await`. Each consumption creates one host iterator. Disposal aborts the session signal, releases state subscriptions and requests iterator closure. Late action results and stream yields are rejected. The SDK never retries a call or resumes a stream.

Pass optional `{ signal }` as the third argument to `context.call` or `context.stream` to cancel one request while keeping the component mounted. The SDK combines that signal with the session signal. A canceled stream requests iterator closure. The host still must honor cancellation to unblock IO.

Observe `ready` for mount failures and `closed` for session failures, including invalid live state, subscription errors and cleanup errors. These failures close the session. Initialization failure releases acquired subscriptions. Cleanup runs exactly once even when a pending mount finishes after disposal. A failed mount must release resources acquired before returning its cleanup function.

Bindings must honor the supplied signal to unblock pending IO. Disposal waits for mounts and iterator cleanup, so a host or component that ignores cancellation can delay teardown. Local declarations are not permissions. The host must authorize requests and enforce remote cancellation. Aborting a session cannot undo remote side effects or establish whether an interrupted action completed. State subscriptions that throw during setup must release their own partially acquired resources.

## Low-level mounts

`mountUi` remains available for consumers that do not need live state or declared actions.

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

Install `@howaboua/pi-durable-git` 0.1.0, React and React DOM 19.3.0, and `@pierre/diffs` 1.4.3 for `/react/diff`. These are optional peers, not dependencies of the generic component API.

`DiffCodeView` preserves Pierre's generic props, imperative ref, controlled or initial items, annotation and header slots, editing provider, selection and full-file loading callbacks. `createDiffOptions` supplies shared defaults without taking ownership of host state. `parseDiffPatch` returns Pierre files, leaving ordering and fallback presentation to the host. `DiffWorkerProvider` takes a bundler-owned `workerFactory`, uses two to six workers, and keeps resource management in Pierre's provider. Hosts can supply their existing editing provider around the viewer.

`mountDiff` is an independent read-only view with loading, error and empty states and unified or split layout. It calls `git.diff` with `{}`. The host resolves the repository and returns `GitDiffResult` from the same Git reader used by agent tools. It does not replace a host's richer edit, review or image-preview interface.

`themeCss` scopes tokens to `[data-durable-ui]`: `--durable-ui-background`, `foreground`, `muted`, `border` and `accent`. It follows the system theme or a `data-theme="light"` or `"dark"` override. Hosts can override these variables for their own palette. No global page styles or font are installed.

See `examples/component-ui` for revision-anchored Git comments through a host binding. `examples/git-ui` demonstrates only the low-level read-only renderer. Neither host depends on Howcode. These packages currently use local development artifacts. Publishing and consumer release packaging are separate work.
