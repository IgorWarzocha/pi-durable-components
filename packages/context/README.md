# Context management for Durable

Continue long conversations through saved notes and clean context windows. Notes, retained history, pending input and rollover progress live in the same SQLite database as your Durable conversation. No Codex account or provider-specific storage is required.

Requires Node 22.19 or newer and Durable 1.1.0.

```sh
npm install https://github.com/IgorWarzocha/pi-durable-components/releases/download/v0.5.0/howaboua-pi-durable-context-0.5.0.tgz
```

## Connect your host

Use your configured `models` collection and `model` reference. Install before opening the Harness, bind before resuming work, and send user input through `management.submit`.

```ts
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createContextManagement } from "@howaboua/pi-durable-context";

const storage = await openNodeSqliteStorage("conversation.sqlite");
const management = createContextManagement({ models });
const registry = createRegistry();
registry.install(management.extension);
const harness = await Harness.open(storage, { models, registry }, ctx);
management.bind(harness, storage);
const conversation = await harness.root(ctx, {
  agent: { model, extensions: [management.extension] },
});

const task = await management.submit(conversation.id, {
  type: "input",
  content: "Continue our work",
  requestId: "message-001",
}, ctx);
const receipt = await harness.waitForTask(task, ctx);
```

The receipt uses Durable's normal task outcomes. A completed input result contains `status`, the native `submission` ID and either the final `answer` entry ID or an unanswered reason. A `new_context` tool call does not finish this managed request early. It follows the rollover's continuation to the final answer. Reusing a `requestId` returns the original task without admitting the input twice.

With Code or Notebook, also call `code.bind(harness)` or `notebook.bind(harness)`. The ordinary `notes`, `history` and `get_context_remaining` tools remain callable inside execution cells. `new_context` stays on the native model surface and must be called alone, outside a cell.

## What happens during a conversation

- `notes` reads and writes virtual paths under `/notes`. Relative paths resolve there. Notes are not workspace files. Each file is limited to 1 MB, with 10 MB of note content per conversation.
- `history` searches retained entries by window UUID and item ID, with bounded retrieval. Searches are case-sensitive literal matches. Old history is never automatically reinserted into the prompt.
- `new_context` reuses fresh notes from a successfully settled run or asks the model to save a checkpoint first. It then starts a clean window and continues from the saved notes. The prompt lists recent note paths, not their contents.
- At 85% and 90% context usage, advisory reminders ask for a checkpoint. `get_context_remaining` reports provider usage plus an estimated tail, or explicitly reports an unknown budget.
- After 25 minutes of observed inactivity, the next managed input waits for the same checkpoint-and-rollover path. Its content, attachments and busy policy remain intact.

The idle clock starts when this component observes actual input settlement. It does not use Durable's task timestamps. Recovery can delay the idle deadline, but cannot move it earlier by guessing from an assistant timestamp.

Normal threshold and manual compaction are declined. Overflow compaction remains an emergency fallback using the configured model, within the same logical window. For a host-initiated rollover, call `management.newContext(conversation.id, ctx)` and await its task. It saves a checkpoint when needed but does not send an extra continuation message.

## Resume and recover

Reopen the same database with the same extensions, bind the new component, then call `harness.resume()`. Persisted managed task IDs remain usable with `harness.getTask` and `harness.waitForTask`. Do not reinstall a different context policy over unfinished work.

If a checkpoint fails or finishes without saving fresh notes, the old window stays intact and pending input remains held. `management.status(id, ctx)` exposes the blocked reason. Call `management.retry(id, ctx)` or send a new user message to retry. Merely reopening the database or resubmitting an existing request ID does not retry it.

Use `harness.abortTask(task, ctx)` to cancel a managed request, including its pending rollover. Cancelling an idle checkpoint cancels the messages held behind it. Use `conversation.abort(ctx)` to stop all foreground work. Resubmit cancelled messages explicitly if you still want them processed.

Direct `conversation.submit` calls, including another extension's delegation or notifications, bypass managed idle admission. Route inputs through `management.submit` wherever that idle guarantee is needed. Native tool rollover still works on directly submitted conversations.

A window change preserves the conversation ID and live Code or Notebook runtime. A process restart does not preserve kernels or shell sessions. Close the Harness and storage using their normal lifecycle when the host exits. Notes and history remain local, but checkpoint and overflow-summary inference still use your configured model.

## Headless presentations

Available in local-development builds, not release 0.5.0.

The browser-safe `@howaboua/pi-durable-context/presentation` entry provides validated host snapshots and pure summary and detail selectors, structurally compatible with `UiCapability` and `UiPresentation`. It does not import the UI runtime.

`contextCapability`, `contextSummaryPresentation` and `contextDetailPresentation` describe virtual notes. Populate `files` from `notes` with `list_files_by_prefix`. Populate nullable `detail` from the `file` returned by `read_file`. Counts and bytes describe only the supplied inventory, which can be bounded. Detail retains the returned line range and total line count. This is not `management.status` or the component's persisted rollover state.

Keep `detail: null` until the host acquires it. Detail must match an item in the supplied inventory. Refresh or clear detail when replacing that inventory. These snapshots are presentation data, not a replacement storage model or raw tool-result envelope. The host owns selection, freshness, binding, authorization and native controls. Summary requests identify a detail presentation but do not fetch data. Declared actions name the existing ordinary `notes` registration. Invoke it with its unchanged arguments and results through a host-authorized binding. No streams, transport adapters or additional lifecycle are introduced.
