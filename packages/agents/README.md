# Durable agents

Delegate to persistent Durable conversations. A worker remembers earlier messages, can answer synchronously, or can keep working after its controller replies. Explicit watches report future worker answers until removed. Add the independent [Board component](../board) when conversations need shared discussions.

The host supplies named profiles as Durable `AgentChange` presets. This package does not launch terminals, route SSH, share context archives, or operate Ask interfaces.

## Install in a host

```sh
npm install https://github.com/IgorWarzocha/pi-durable-components/releases/download/v0.10.0/howaboua-pi-durable-agents-0.10.0.tgz
```

Upgrading from 0.5.0? Board is now a separate package. Follow the migration section below before resuming saved conversations.

Use Durable 1.4.0 and a persistent storage backend for restart recovery. Create a fresh component for each Harness. Install the extension before opening the Harness, then bind it before enabling scheduling.

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

Profiles can select models, thinking levels, instructions, tools, extensions, and an environment-relative cwd. Unset fields inherit the controller's stored configuration and host defaults. Install any extensions referenced by profiles in the same registry. A profile's `blocking` setting overrides the spawn request. Set `createAgents({ shareContext: true, ... })` to share Context reads with new workers; it defaults to false. Hosts migrating from the previous shared-read behavior should set it to true. Profile `shareContext: false` isolates that worker regardless of the controller setting, while `true` or unset follows the controller. A worker already in a private group cannot widen access by spawning with `true`.

With the Context component installed, visibility groups govern its foreign-conversation notes/history reads. Existing conversations without a recorded group remain mutually visible, and Context without Agents is unchanged. This is not a storage or host-tool security boundary. It does not copy parent prompts or transcripts, and it does not change caller-only note writes.

The extension registers only `agents`. Select `agents.extension` on controllers. Code and Notebook discover it without an adapter. Workers inherit the controller's selected extensions unless their profile changes the selection. Restrict the profile's tools or extensions when workers should not delegate further.

## Start delegating

Call `agents` with `{}` for the current profiles and action arguments. For example:

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

To enable `board_thread_id` on spawn, pass the Board component as `createAgents({ profiles, board })` and install, select and bind both extensions. Admission validates the thread before creating the worker and adds a `board read_thread` reference to its task. Without that explicit integration, a thread handoff fails before admitting work. Ordinary delegation does not need Board.

`list` and `find` discover workers created by this component in the current Harness. Names are unique within that Harness. Numeric names are reserved for conversation IDs. An exact conversation ID can also address a host-created conversation, including a controller. Delegating to or watching yourself is rejected.

Use the returned conversation ID to inspect a worker through the host's Durable conversation view or the Context component's targeted `history` tool. Agents does not register a transcript-reading action.

## Migrating from bundled Board

Install and select `board.extension` separately, including on saved conversations before resuming their work. Board's [migration guide](../board/README.md) covers host setup and retained storage. Move board archive imports to `@howaboua/pi-durable-board` and board presentation imports to `@howaboua/pi-durable-board/presentation`.

Use `board attach` and `board detach` with native conversation IDs instead of the former Agents actions. `spawn` and `list` no longer return `boardAgent`. Call `board` with `{}` in the target conversation for its board address. Board derives natural membership from Durable ownership, including workers created without this package.

## Cancellation and recovery

Cancelling a blocking controller turn detaches its waiter. The admitted worker task continues and reports its eventual result. An ordinary controller abort leaves background workers, reporters, and explicit watches alive. To stop the owned background subtree, the host calls `root.abort(context, { background: true })`. `unwatch` removes only the subscription, not the worker's task.

On reopen, use the same persisted storage with a fresh component and reinstalled profile definitions. Bind the reopened Harness and its storage before calling `harness.resume()` or admitting submissions. Stable request IDs deduplicate worker inputs, sends, and completion submissions. Reopening does not replay a new worker side effect or create another conversation for the same tool call.

Reports use Durable `whenBusy: "followUp"`. An idle controller starts a new run. A busy controller receives the report after its current answer. A report already queued when the controller is aborted can be withdrawn by Durable. An admitted, withdrawn report is not resubmitted under another ID. Answers and failures shared by a delegation and explicit watch are reported once.

Failures retain a failed status and reason. Blocking failures set the tool result's `isError`. Pending native work remains monitored rather than being treated as complete. There is no inferred terminal blockage or synthetic assistant response.

[Parity evidence](../../docs/parity/agents.md) records the native boundaries and tests.

## Host observation and control

After binding, `agents.roster(context)` returns every registered worker's target, name, label, profile and controller, plus its native Durable `owner` edge and `state`. State is `idle` or `working` with the native run task ID. Controller metadata records the original delegation controller. It does not replace native task ownership.

The roster uses separate committed reads, not an atomic frame. Refresh it through the host's native Harness commit subscriptions or watches. Read transcripts through Durable conversation views or history. No separate worker graph or observer lifecycle is introduced.

To reuse a component after runtime close, first close the old Harness and wait for its task invocations to finish, then call `agents.unbind(oldHarness)` before binding the replacement. Release only clears a matching binding, so stale cleanup cannot clear a newer Harness. The component never closes the Harness or storage itself.

`agents.stop(target, context, options?)` calls the worker's native conversation abort and waits for its ordinary ownership scope to become idle. Nested background workers survive by default. Pass `{ background: true }` deliberately to cross those boundaries. Stopping does not delete the worker or change completion-report policy.

`agents.message({ target, sender, message, requestId }, context)` submits an attributed message with `whenBusy: "steer"` and returns the native submission. Use a unique, stable request ID for each operation and reuse it when retrying an uncertain outcome. This sends no additional completion report. Both controls require a registered worker. The sender must be an existing conversation. The host owns authorisation of every read and control, including sender attribution.

## Headless presentations

The browser-safe `@howaboua/pi-durable-agents/presentation` entry provides validated host snapshots and pure summary and detail selectors, structurally compatible with `UiCapability` and `UiPresentation`. It does not import the UI runtime.

`agentsCapability`, `agentsSummaryPresentation` and `agentsDetailPresentation` describe a roster page and a nullable latest reply. Build `agents` from the `agents` tool's `list` or `find` result. The host acquires detail through its Durable conversation view or targeted history, then supplies `target`, `reply` and `truncated`. The summary counts only the supplied page, not the entire fleet. A null reply means no assistant answer was returned.

Keep `detail: null` until the host acquires it. Detail must match an item in the supplied inventory. Refresh or clear detail when replacing that inventory. These snapshots are presentation data, not a replacement storage model or raw tool-result envelope. The host owns selection, freshness, binding, authorization and native controls. Summary requests identify a detail presentation but do not fetch data. Declared actions name the existing ordinary `agents` registration. Invoke it with its unchanged arguments and results through a host-authorized binding. No streams, transport adapters or additional lifecycle are introduced.

Board presentations now come from `@howaboua/pi-durable-board/presentation`.
