# Context management for Durable

Continue long conversations through saved notes and clean context windows. Notes, retained history, pending input and rollover progress live in the same SQLite database as your Durable conversation. No Codex account or provider-specific storage is required.

Requires Node 22.19 or newer and Durable 1.4.0.

```sh
npm install https://github.com/IgorWarzocha/pi-durable-components/releases/download/v0.7.1/howaboua-pi-durable-context-0.7.1.tgz
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

The receipt uses Durable's normal task outcomes. A completed input result contains `status`, the native `submission` ID and either the final `answer` entry ID or an unanswered reason. A `new_context` tool call keeps the original native input open until the final answer. Delegation, watches and direct submission waits therefore see the same completion, without a Context-specific connector. Reusing a `requestId` returns the original task without admitting the input twice.

With Code or Notebook, also call `code.bind(harness)` or `notebook.bind(harness)`. The ordinary `notes`, `history` and `get_context_remaining` tools remain callable inside execution cells. `new_context` stays on the native model surface and must be called alone, outside a cell.

## What happens during a conversation

- `notes` reads and writes virtual paths under `/notes`. Relative paths resolve there. Notes are not workspace files. Each file is limited to 1 MB, with 10 MB of note content per conversation. Supply `target` with another conversation's numeric ID as a string to read its notes. Writes can only target the calling conversation.
- `history` searches retained entries by window and item ID, with bounded retrieval. Its optional `target` selects another conversation in the same storage. Searches are case-sensitive literal matches. Old history is never automatically reinserted into the prompt. Conversations without Context windows use `conversation:<id>` as their window ID.
- `new_context` requires fresh notes and a standalone native tool round. Without fresh notes it returns `checkpoint_required`, asking the model to save its checkpoint and call again. Once the round completes, it cuts the context and continues within the same native input. If queued input or other foreground work prevents a safe cut, the model receives an explicit skipped-rollover message and the window stays intact. The prompt lists recent note paths, not their contents.
- At 85% and 90% context usage, advisory reminders ask for a checkpoint. An optional token budget suggests finishing the current task and starting a fresh window before the next task. `get_context_remaining` reports provider usage plus an estimated tail, or explicitly reports an unknown budget.
- Automatic idle rollover defaults off. Enable it with `createContextManagement({ models, automaticIdleRollover: true })`. After 25 minutes of observed inactivity, the next managed input rolls only if the latest completed run saved fresh notes. Otherwise it is admitted normally, without a synthetic checkpoint. Its content, attachments and busy policy remain intact.

Set `idleRolloverMinutes` to `0`, `25`, `55`, `115`, `355` or `715` to choose the idle interval. Legacy `5` and `15` minute intervals are also supported. An explicit interval overrides `automaticIdleRollover`, including `0` to disable it. The boolean API still uses 25 minutes when enabled.

For models with a context larger than 272,000 tokens, `taskBoundaryReminderTokens` enables a once-per-window suggestion at a token budget. It defaults to `0`, disabled. Source presets are `250_000`, `300_000`, `400_000` and `450_000`; any non-negative safe integer is accepted. The suggestion does not force a rollover or replace the 85% and 90% reminders. Invalid configuration throws when creating the component.

```ts
const management = createContextManagement({
  models,
  idleRolloverMinutes: 55,
  taskBoundaryReminderTokens: 300_000,
});
```

The idle clock starts when this component observes actual input settlement. It does not use Durable's task timestamps. Recovery can delay the idle deadline, but cannot move it earlier by guessing from an assistant timestamp.

Keep each task checkpoint at a stable note path and update it in place, including completion. Link separate reusable findings and deferred ideas instead of copying them. Deferred work is not authorization to implement. Include checkpoint paths in handoffs. The bootstrap lists only five recent paths; use `notes` list or search to find others.

All conversations in the same storage can be read, including host-created peers. Board membership does not grant or restrict this access. Keep private conversations in a separate storage boundary. Use conversation IDs returned by Agents or the host. For example, `history` with `{"action":"search_contents","target":"42","query":"deployment"}` searches conversation 42 without waking it. These reads do not copy its context into the caller's prompt beyond the requested results.

Normal threshold and manual compaction are declined. Overflow compaction remains an emergency fallback using the configured model, within the same logical window. For a host-initiated rollover, call `management.newContext(conversation.id, ctx)` and await its task. It requests a checkpoint through native instructions when needed, without inventing a user message or sending an extra continuation after the cut. Rollover instructions remain chronological system messages in Durable, projected to developer messages by providers that support that role. User and peer messages retain their original roles.

## Resume and recover

Reopen the same database with the same extensions, bind the new component, then call `harness.resume()`. Persisted managed task IDs remain usable with `harness.getTask` and `harness.waitForTask`. Do not reinstall a different context policy over unfinished work.

Hosts that retain the component across Harness startup retries can call `management.unbind(harness)` before binding a replacement. First stop new host calls, drain in-flight calls and await closure of that Harness and its task invocations. Unbinding releases only the matching binding. It does not close the Harness, cancel work or change persisted state. Repeated or stale cleanup cannot clear a different Harness's binding. Keep the original Models collection valid across rebinding, or create a new component if that collection must be replaced. Install the extension before opening each replacement Harness and bind its exact storage before resuming.

If a checkpoint fails or finishes without saving fresh notes, the old window stays intact and pending input remains held. `management.status(id, ctx)` exposes the blocked reason. Call `management.retry(id, ctx)` or send a new user message to retry. Merely reopening the database or resubmitting an existing request ID does not retry it.

Use `harness.abortTask(task, ctx)` to cancel a managed request, including its pending rollover. Cancelling an idle checkpoint cancels the messages held behind it. Use `conversation.abort(ctx)` to stop all foreground work. Resubmit cancelled messages explicitly if you still want them processed.

Direct `conversation.submit` calls, including another extension's delegation or notifications, bypass managed idle admission. Route inputs through `management.submit` wherever that idle guarantee is needed. Native tool rollover works on directly submitted conversations and does not settle their inputs early. Host-initiated rollover still uses the managed checkpoint task and native idle boundary.

A window change preserves the conversation ID and live Code or Notebook runtime. A process restart does not preserve kernels or shell sessions. Close the Harness and storage using their normal lifecycle when the host exits. Notes and history remain local, but checkpoint and overflow-summary inference still use your configured model.

## Headless presentations

The browser-safe `@howaboua/pi-durable-context/presentation` entry provides validated host snapshots and pure summary and detail selectors, structurally compatible with `UiCapability` and `UiPresentation`. It does not import the UI runtime.

`contextCapability`, `contextSummaryPresentation` and `contextDetailPresentation` describe virtual notes. Populate `files` from `notes` with `list_files_by_prefix`. Populate nullable `detail` from the `file` returned by `read_file`. Counts and bytes describe only the supplied inventory, which can be bounded. Detail retains the returned line range and total line count. This is not `management.status` or the component's persisted rollover state.

Keep `detail: null` until the host acquires it. Detail must match an item in the supplied inventory. Refresh or clear detail when replacing that inventory. These snapshots are presentation data, not a replacement storage model or raw tool-result envelope. The host owns selection, freshness, binding, authorization and native controls. Summary requests identify a detail presentation but do not fetch data. Declared actions name the existing ordinary `notes` registration. Invoke it with its unchanged arguments and results through a host-authorized binding. No streams, transport adapters or additional lifecycle are introduced.
