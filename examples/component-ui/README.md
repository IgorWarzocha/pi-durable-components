# Interactive Git review host

This independent host binds Git review through the public UI SDK using one `connectUiBinding` connection and one `bindCapability` instance. The host-specific contract lives in `components.ts` and the DOM renderer in `views.ts`. The host chooses permissions, handlers, styling, placement and presentation transitions. The transport dispatcher treats snapshots and results as opaque JSON.

Summary and detail share the same capability instance. Open detail requests a named presentation through the SDK. Dismiss detail or Escape hides the retained detail session without discarding drafts. Comment counts continue updating while detail is hidden. Unmount components releases both presentations and their binding.

Git review uses the public native Git reader. Select a displayed line and save a comment. The host verifies the diff revision and the path, side and line anchor before writing. Comments are serialized to an explicit JSON store through atomic rename. Earlier revision comments remain visible and labelled.

## Run

From the repository root:

```sh
bun run build
node examples/component-ui/server.mjs /absolute/path/to/worktree /absolute/path/to/comments.json
```

Open the printed `http://127.0.0.1:4319` URL. `PORT` changes the port. The server builds the browser client with Bun.

Without arguments, the server creates a temporary Git workspace and a separate temporary comment store, then prints both paths. Edit a file in that workspace, then refresh the diff. Supplying a comment-store path retains comments across host restarts.

## Ownership and limits

The server listens only on loopback. API requests require the exact Host header and a random bearer token embedded in the local page. A supplied Origin must match. Browser GET subscriptions without Origin must declare `Sec-Fetch-Site: same-origin`. There is no CORS grant. The page also validates its Host header to resist DNS rebinding.

Snapshot subscriptions subscribe before sending the initial frame. Slow subscribers are disconnected rather than buffering without a bound. Unmount aborts transport work and disposes the capability instance. No action is retried. Cancelled or disconnected writes may have completed. Refresh saved comments before manually resubmitting an uncertain save.

Comment writes are serialized within this process. Use one host process per store. Writes finish once atomic persistence begins, even if the browser disconnects. The diff hash is a review revision, not a commit ID. Text lines with ordinary Git paths support anchors. Binary files and Git-quoted unusual paths remain visible in raw diff text but have no selectable anchors. This example does not integrate Pierre or image rendering.

Stop with Ctrl+C. The host aborts connections and joins pending comment writes. Temporary workspaces and stores are left at the printed paths for inspection.
