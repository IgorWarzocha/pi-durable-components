# Durable agents

The source tree targets upstream 1.0.4. The release archive linked below retains its original 1.0.2 peer requirements.

Delegate to persistent Durable conversations and share findings on their discussion board. A worker remembers earlier messages, can answer synchronously, or can keep working after its controller replies. Explicit watches report future worker answers until removed.

The host supplies named profiles as Durable `AgentChange` presets. This package does not launch terminals, route SSH, share context archives, or operate Ask interfaces.

## Install in a host

```sh
npm install https://github.com/IgorWarzocha/pi-durable-components/releases/download/agents-v0.3.1/howaboua-pi-durable-agents-0.3.1.tgz
```

Use Durable 1.0.4 and a persistent storage backend for restart recovery. Create a fresh component for each Harness. Install the extension before opening the Harness, then bind it before enabling scheduling.

```ts
import { createAgents } from "@howaboua/pi-durable-agents";
import { createRegistry, Harness } from "@earendil-works/pi-durable";

const agents = createAgents({
  profiles: {
    general: {
      description: "General-purpose worker",
      agent: { instructions: "Complete the delegated task and return your result." },
    },
  },
});
const registry = createRegistry();
registry.install(agents.extension);
const harness = await Harness.open(storage, { models, registry, env }, context);
agents.bind(harness, storage);
const root = await harness.root(context, {
  agent: { model, extensions: [agents.extension] },
});
```

`storage`, `models`, `env`, `model`, and the Chord `context` belong to the host. Bind the exact Harness and storage passed to `Harness.open`. Watches use public submission scans and waits to follow actual completion, including tool rounds and continuation hooks. The component does not own or close either binding.

Profiles can select models, thinking levels, instructions, tools, extensions, and an environment-relative cwd. Unset fields inherit the controller's stored configuration and host defaults. Install any extensions referenced by profiles in the same registry. A profile's `blocking` setting overrides the spawn request.

The extension registers `agents` and `board` together. Select `agents.extension` on controllers. Code and Notebook discover both tools without an adapter. Workers inherit the controller's selected extension unless their profile changes the selection. Restrict the profile's tools or extensions when workers should not delegate further.

## Start delegating

Call `agents` with `{ "action": "help" }` for the current profiles and action arguments. For example:

```json
{
  "action": "spawn",
  "agent_type": "general",
  "label": "Document reader",
  "message": "Summarize the supplied document.",
  "blocking": false
}
```

An asynchronous call returns a stable conversation `target`, worker `name`, and durable `dispatch` and `reporter` task IDs. Completion arrives as an attributed user-input submission. Blocking calls return the worker's reply directly. Use `assign` for another task and `send` for a message without waiting or adding monitoring.

`list` and `find` discover workers created by this component in the current Harness. Names are unique within that Harness. Numeric names are reserved for conversation IDs. An exact conversation ID can also address a host-created conversation, including a controller. Delegating to or watching yourself is rejected.

`read` returns the newest assistant reply or a bounded recent transcript page. Text is capped at 36,000 characters per result. Use `before` to continue through older entries and `entry` with `nextOffset` to retrieve truncated text. This reads conversation data, not a terminal.

## Discuss on the board

Call `board` with `{ "action": "help" }` for the action arguments, current board ID and your board address. Spawned workers join their controller's board automatically. Use the `boardAgent` address returned by `agents spawn` or `agents list` for notifications and subscriptions.

```json
{
  "action": "post",
  "new_channel_name": "findings",
  "text": "The parser accepts the new format. Validation still needs review."
}
```

Post to an existing `channel_name` to start another thread, or to a `thread_id` to reply. Search posts and channels, list threads, and read complete posts with the returned cursors and text offsets. Searches use Unicode case folding. Results fit within 8,000 serialized UTF-8 bytes and expose continuation fields rather than silently dropping text.

Channel subscriptions notify agents about first posts. Thread subscriptions notify them about replies. Authors subscribe automatically unless they explicitly unsubscribed. `agents_to_notify` adds one-time recipients. Notices go only to running agents. They do not start idle workers or queue notifications for absent members. Use `agents send` or `agents assign` when a recipient should start working.

Notices are best effort. Failure or cancellation drops undelivered notices rather than carrying them into another run. A normal input arriving at a final-answer boundary can also supersede a notice. The post stays in the archive. Reopening an interrupted native run preserves that same run's pending notices.

`agents attach` joins an idle root agent to your board. `agents detach` removes one of your idle descendants and restores its earlier board. Both require a target without board children. Attachment shares board membership, not context or task ownership.

Boards live in the host's Durable storage, not a separate database or process. `list_boards` discovers saved boards in that storage. Read actions accept `board_id` to browse an older board without joining it. Independent roots and forks get independent boards. Reopen the same storage to retain posts and subscriptions.

## Cancellation and recovery

Cancelling a blocking controller turn detaches its waiter. The admitted worker task continues and reports its eventual result. An ordinary controller abort leaves background workers, reporters, and explicit watches alive. To stop the owned background subtree, the host calls `root.abort(context, { background: true })`. `unwatch` removes only the subscription, not the worker's task.

On reopen, use the same persisted storage with a fresh component and reinstalled profile definitions. Bind the reopened Harness and its storage before calling `harness.resume()` or admitting submissions. Stable request IDs deduplicate worker inputs, sends, and completion submissions. Reopening does not replay a new worker side effect or create another conversation for the same tool call.

Reports use Durable `whenBusy: "followUp"`. An idle controller starts a new run. A busy controller receives the report after its current answer. A report already queued when the controller is aborted can be withdrawn by Durable. An admitted, withdrawn report is not resubmitted under another ID. Answers and failures shared by a delegation and explicit watch are reported once.

Failures retain a failed status and reason. Blocking failures set the tool result's `isError`. Pending native work remains monitored rather than being treated as complete. There is no inferred terminal blockage or synthetic assistant response.

[Parity evidence](../../docs/parity/agents.md) records the native boundaries and tests.
