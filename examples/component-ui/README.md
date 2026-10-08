# Interactive component host

This independent host binds two unrelated capabilities through the public UI SDK. Each uses one `connectUiBinding` connection and one `bindCapability` instance. Notebook uses its public `/presentation` contract. The host-specific Git review contract lives in `components.ts`. Optional DOM detail renderers live in `views.ts`. The host chooses permissions, handlers, styling, placement, and presentation transitions. The transport dispatcher treats snapshots and results as opaque JSON.

The compact summary and detail presentation share the same capability instance. Open detail requests a named presentation through the SDK. The host handles that request without switching on capability names. Dismiss detail or Escape hides the retained detail session. Reopening does not rebind, cancel active execution, discard drafts, or reset the live result journal. Summary status and comment counts continue updating while detail is hidden. Unmount components is the separate destructive lifecycle control that releases both presentations and their binding.

- Notebook installs `createNotebookMode` in a real Durable Harness. Host-authored tool calls run through the public `ToolTask`, including argument validation, hooks, unsafe replay policy, owned cancellation, and real Deno execution. No model or faux provider is used. Run source, resume a yielded cell with Wait, terminate it, or inspect notebook state. The result journal uses the SDK's stream API over a second NDJSON subscription.
- Git review uses the public native Git reader. Select a displayed line and save a comment. The host verifies the diff revision and the path, side, and line anchor before writing. Comments are serialized to an explicit JSON store through atomic rename. Earlier revision comments remain visible and labelled.

## Run

From the repository root, build the packages first:

```sh
bun run build
node examples/component-ui/server.mjs /absolute/path/to/worktree /absolute/path/to/comments.json
```

Open the printed `http://127.0.0.1:4319` URL. `PORT` changes the port. The server builds the browser client with Bun. Deno and the repository's native Notebook dependencies must be installed.

Without arguments, the server creates an explicit temporary Git workspace and a separate temporary comment store, then prints both paths. Create or edit a file in that workspace, or use Notebook to write one, then refresh the diff. Supplying a comment-store path retains comments across host restarts. Notebook checkpoints live beside that store. The Harness uses memory storage, so its transcript and conversation identity do not survive a host restart. Checkpoints are not advertised as a restartable host session.

Try this source to see exec and wait independently:

```ts
text("before yield");
await yield_control();
text("after wait");
```

The yielded cell ID fills the Wait field. Run `text(ALL_TOOLS)` to discover the installed ordinary registrations. Notebook can invoke those tools without a component-specific bridge.

## Ownership and limits

This is a trusted local execution host, not an arbitrary-code sandbox. Notebook source has native Deno capabilities in the explicitly selected execution environment. Do not expose the host to untrusted users. The server listens only on loopback. API requests require the exact Host header and a random bearer token embedded in the local page. A supplied Origin must match. Browser GET subscriptions without Origin must declare `Sec-Fetch-Site: same-origin`. There is no CORS grant. The page also validates its Host header to resist DNS rebinding.

Snapshot subscriptions subscribe before sending the initial frame. Slow subscribers are disconnected rather than buffering without a bound. Cancelling or disconnecting an active Notebook request aborts and joins the channel's dedicated conversation, including any yielded cells. Notebook cells belong to the conversation rather than to the observing tool invocation. The host publishes completion after that scope drains. Unmount aborts transport work and disposes both capability instances. No action is retried. Cancelled or disconnected writes may have completed. Refresh saved comments before manually resubmitting an uncertain save.

Comment writes are serialized within this process. Use one host process per store. Writes finish once atomic persistence begins, even if the browser disconnects. The diff hash is a review revision, not a commit ID. Text lines with ordinary Git paths support anchors. Binary files and Git-quoted unusual paths remain visible in raw diff text but have no selectable anchors. This example does not integrate Pierre or image rendering.

Stop with Ctrl+C. The host aborts connections, joins conversation-owned tasks, closes Notebook resources, and closes the Harness. Temporary workspaces and stores are left at the printed paths for inspection.
