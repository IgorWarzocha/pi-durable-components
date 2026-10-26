# Agents parity

## Pinned references and approved scope

The source is [`@howaboua/pi-shepherdr` 0.2.12](https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/b2006db9def12c373ae48e70044d30f7d6b7e34f/packages/pi-shepherdr), revision `b2006db9def12c373ae48e70044d30f7d6b7e34f`. Its `agents-tool.ts`, `agents-contract.ts`, `agents-discovery.ts`, `agents-spawn.ts`, `agents-work.ts`, and monitoring owners establish the action, delegation, delivery, and watch contracts.

The Durable reference is revision `f5d20047b3ad43d068a8eb61bd4e1f193bedbce6` of [earendil-works/pi](https://github.com/earendil-works/pi/tree/f5d20047b3ad43d068a8eb61bd4e1f193bedbce6/packages/durable). [Example 22](https://github.com/earendil-works/pi/blob/f5d20047b3ad43d068a8eb61bd4e1f193bedbce6/packages/durable/test/examples/22-subagent-foreground.ts) establishes safe tool replay and child-input request IDs. [Example 23](https://github.com/earendil-works/pi/blob/f5d20047b3ad43d068a8eb61bd4e1f193bedbce6/packages/durable/test/examples/23-subagent-background.ts) establishes background anchors and idempotent report submissions. Implementation uses the installed public Durable 1.0.2 API, not private imports. Reference checkouts were read-only during implementation.

Igor selected Durable-native delegation, profiles, messages, blocking and asynchronous results, and watches. Board was initially bundled here. The approved 2026-10-16 extraction moves it into an independent [Board package](board.md). Herdr machine, pane, process, SSH and terminal integration and Ask answer actions remain outside this package. There are no built-in review or btw workflows.

## Context sharing correction

The whole-package audit against read-only Pi Stuff `12c4357b2c401fe9be8c6c82d2ae252c0f986937` found that source `share_context` controls access to shared notes and history, not parent transcript copying or prompt-cache identity. Calling attachment a terminal-only exclusion had dropped that functional policy.

`AgentsOptions.shareContext` now defaults to false, matching the source controller. A profile with `shareContext: false` always isolates its new worker. A profile with true or no override follows the controller. Before dispatch, the spawn transaction saves a private visibility group or inherits the parent's group. Context checks group equality before foreign notes or history reads in either direction. An already isolated parent cannot widen its group through a child. Writes still belong to the caller. Missing records retain legacy shared-storage behaviour; native forks inherit the saved policy and rewinds cannot erase it. This shared internal document is bundled independently into Agents and Context. It requires no host bridge, package dependency or component-specific execution adapter.

A disposable real-Harness probe exercised the source default, explicit controller sharing, profile isolation, denied foreign writes, permitted and denied ordinary notes reads, denied history reads and native fork inheritance. No permanent tests or external provider calls were added. Consuming applications must choose their sharing policy explicitly when preserving a previously shared workspace.

## Preserved contracts

The 2026-10-19 alignment inspects Pi Stuff `7f3295e67a8e6146b2a6922b56a06fa4db5c3a32`, including its local commits. Agents now advertises explicit help-backed discovery through ordinary registration metadata. Its help prefers short, two-word labels without enforcing a word count and asks for distinct worker scope, outcome and relevant context rather than lists of forbidden investigations. A disposable real SQLite/Harness call verified this help is delivered through the actual tool. Herdr process controls, Chill Actions and the experimental PCC alternate-prose mode remain excluded; no host profiles or standing prompt broker are installed.

The approved refresh adopts selected contracts from source revision `69f50cf70e8a7b05c2349be6227f521b6504f80e`: empty-call discovery for both tools, spawn thread handoff, and fresh subscription catch-up. The original pins remain the baseline for other behavior. Board summary/detail presentations are native host contracts, not a port of the source viewer or archive server.

The approved 2026-10-10 native cleanup removes `agents read` in favor of Context's targeted history and the host's Durable conversation views. It also removes the terminal-origin label word-count restriction. Completion delivery, messaging and persistent watches remain separate contracts.

| Source capability | Durable implementation and evidence |
| --- | --- |
| `help` and profiles | Empty calls and explicit help describe the actual action arguments and configured profile descriptions. Host profiles are named `AgentChange` configurations with the same blocking-policy precedence. |
| `list`, `find` | Session-wide component registry, stable conversation IDs, unique names and labels, case-insensitive query and native idle or working state. Pages contain at most 30 workers with `nextOffset`. Discovery covers component-created conversations, not an external process fleet. |
| `spawn` | One atomic commit creates the background anchor, child conversation, profile configuration, registry record, dispatch task, and completion reporter. With an explicitly supplied Board component, optional `board_thread_id` validates a thread in the caller's current board before admission and adds its read reference to the child's task. Labels must be nonblank; their word count is unrestricted. Derived names retain slug normalization, collision suffixes and the 32-character bound. |
| `assign` | Sends an attributed task to an existing worker with a fresh task-scoped dispatch. Blocking defaults true. A self-delegation is rejected instead of deadlocking. |
| Blocking completion | Waits for the admitted child submission, returns its real answer entry's text, and suppresses an asynchronous echo after the blocking tool completes. Worker failure returns failed status, reason and detail with `isError`. |
| Asynchronous completion | Returns durable continuation IDs immediately. The background completion task waits for one delegation and submits its outcome to the controller after the controller can already have replied. Multiple requests answered by one assistant entry share one successful report ID. |
| `send` | Idempotent attributed native input admission, using `whenBusy: "steer"`. Starts idle recipients and steers active ones. No waiter, delegation record, completion reporter, or implicit watch is created. Durable itself may start a generation task. |
| `watch` | Explicit persistent background task, separately keyed by controller and target. Reconciles native input submissions, retains already-admitted pending input IDs, and waits for actual settlement across generation successors. Finished delegation reporters are not revived as persistent watches. Shared answers deduplicate by answer entry and shared failures by input ID. |
| `unwatch` | Removes membership without stopping the worker. The watch wakes and terminates even when its observed worker is still running. Replaying an older watch or unwatch call returns its saved receipt and cannot reverse a newer membership change. |
| Cancellation | Blocking cancellation detaches the caller while worker ownership remains behind a background anchor. Eventual completion reports after the cancelled tool settles. Host background-inclusive abort reaches workers, dispatches, reporters and watches. |
| Restart | Tool-call identity records prevent duplicate spawn or assign effects. Worker input, send, and report request IDs prevent duplicate admissions. Durable checkpoint phases retain the report before delivery. Document watch handles are reacquired, not serialized. |

## Native differences within the approved boundary

- `target` is a Durable conversation ID rendered as a string, not a machine-qualified pane ID. Registered names are unique across one Harness. Numeric names are rejected so names cannot shadow stable IDs. Hosts can address an existing unregistered conversation by exact ID, but discovery lists only component-created workers.
- Profiles are supplied by the host. They are not process launch arguments, remote preparation scripts, or an implicit copy of a named built-in source profile. `cwd` stays within the host's execution environment. The excluded review `base` argument and layout fields are absent.
- Discovery reports native idle or working state from `LiveDoc.run`. There is no invented Herdr blocked, done, or unknown process state. Delegation receipts report done or failed. Native tasks waiting on tools remain pending work. Ask and terminal-derived blockage reports are deliberately absent.
- Source terminal reads and the previous Agents transcript pager are absent. Use Context `history` with the returned conversation ID as `target`, or native Durable views in a host UI. Shared notes and history reads do not require board attachment.
- Source Pi command dispatch is excluded with the Pi process integration. A leading slash is literal task input. This component registers no Pi commands or TUI surfaces.
- Report delivery uses Durable's ordinary input-submission boundary with `whenBusy: "followUp"`, as in example 23. The source's Conversion-specific prepared-turn staging cannot be imported. No synthetic assistant entry is used. Durable's queued-input abort semantics can withdraw an already admitted report. A withdrawn report is not replayed under a new request ID.
- Worker configuration inherits Durable's normal stored-agent copy. The host explicitly limits child tools and extensions if needed. There is no compatibility emulation of `ExtensionAPI`, and no component-specific Code or Notebook bridge.
- The host calls `bind(harness, storage)` after opening and before scheduling, using the exact public Harness and storage passed to `Harness.open`. Pending watches reacquire these capabilities on every reopen. Storage supplies bounded historical input scans, and `Harness.submission(id).wait()` supplies real settlement. Generation-task completion alone is not a completion signal because Durable also completes generations when transferring a run to a successor.
- Context tool rollover preserves the original native input through its final answer. A real-Harness composition probe verified delegation receives that final answer rather than the intermediate `new_context` call. No special Context connector is installed in Agents.

## Executable evidence

`packages/agents/test/agents.test.ts` runs native Harness, registry, tasks, MemoryStorage, file-backed SQLite, and pi-ai's public faux provider. It tests production tool calls rather than substituting a mock `ToolExecutionApi`.

The six delegation workflows retain independent lifecycle and persistence boundaries: cancelling a blocking caller detaches its worker, background-inclusive abort owns the worker subtree, blocking replay admits one child and one task input, asynchronous reports survive repeated reopen, watches deduplicate delegation reports and stop while a worker remains busy, and a reopened watch reports the settled input answer rather than an intermediate tool-use message. The last scenario uses a message-only send so a delegation reporter cannot mask a broken watcher.

`packages/board/test/board.test.ts` now owns the three standalone file-backed SQLite board workflows. They protect immutable former-board archives and session isolation, notices confined to an active input across abort and provider failure, and interrupted post replay without duplicate posts or notices. Replay compares the original acknowledgement with the resumed result and observes the delivered notice and saved post.

Refresh validation passed all nine retained delegation and board workflows. A disposable SQLite-Harness probe exercised empty-call discovery, valid thread handoff and rejected thread admissions, idle catch-up and reopen deduplication. Actual board pages also passed the UI SDK's capability binding, host invocation and disposal path. The probe was removed. No permanent tests or live provider claims were added.

Earlier implementation and review validation covered profile configuration and blocking precedence, busy and idle sends, worker failure detail, excluded-action validation, bounded reads, Unicode search, pagination and response budgets. It also reproduced an idle-watch document-wake fault, exercised host-created peers and unrelated Fleet wakes, and checked settlement across yield, terminate and handoff paths. Saved-export probes checked full bodies, authors, archive ownership and corrupt storage failures. These feature and regression tours are no longer permanent suite cases. The transaction-draft escape found during recovery validation was corrected by copying receipt fields before leaving the transaction. Historical Code and Notebook toolkit validation exercised board calls through ordinary registration discovery, not a component-specific bridge.

A pre-refresh captured first request through the real Harness contained an Agents schema of 2,700 UTF-8 bytes and its 46-byte description. Board added a 232-byte action-only schema and a 63-byte description, 342 bytes for its complete tool declaration. These are historical measurements, before empty-call discovery and thread handoff. Strict action fields are validated at execution and described by help. The extension adds no standing prompt sections.

Earlier validation included 12 delegation workflows, board workflows, strict TypeScript with `exactOptionalPropertyTypes`, and the aggregate toolkit gate. Separate real-Harness delivery probes exercised a notice during a tool round and SQLite reopen after pending admission, before-request delivery, and yield-receipt commit. Those probes are historical evidence, not additional cases in the retained suite.

Native model-provider side effects retain Durable's own interruption and generation-recovery semantics. These tests do not claim that a provider request is exactly-once or that remote terminal state survives a restart.

## Pi 1.4 source alignment

Compared read-only Pi Stuff `3d0faf5a6f0bc67c0bd9248d07da6ddfa901b281` against `7f3295e67a8e6146b2a6922b56a06fa4db5c3a32`. The ordinary Agents registration now permits parallel execution. Help recommends `await Promise.allSettled` for JavaScript fan-out that waits for all results, including failures. `blocking: false` is for continuing other work, not a prerequisite for parallelism.

The source reserves process names during asynchronous launch. Durable already allocates unique names, workers and receipts inside the same transaction. Concurrent same-label requests therefore require no new in-memory reservation owner. Native `AgentChange.instructions` already preserves exact role text and renders it after extension project sections. No Pi flag, prompt rewriting or worker-role event channel is imported. Process notification diagnostics and remote launch corrections remain outside the accepted boundary.

The Fleet document now declares Durable 1.4's required checkpoint policy, storing a base after 64 accumulated deltas without changing its persisted kind or version. Existing watch and worker task classifiers regard every nonterminal state, including sleeping, as live.

A disposable actual-Harness probe admitted two blocking same-label spawns in one native tool round, held both workers concurrently and observed unique `same-label` and `same-label-2` names before either completed. Both calls settled after release. Captured worker requests preserved a multiline role, including a tab and trailing newline, after the shared project section. Strict TypeScript passed against Durable, Pi AI and Chord 1.4.0. No permanent tests or live-provider claims were added. The coordinator owns the final repository gate.

## Attribution

Background ownership and report submission patterns adapt Durable example 23 under its MIT license. The upstream copyright and permission notice are retained in `packages/agents/src/tasks.ts` and the published `packages/agents/NOTICE`. Shepherdr's delegation contracts are used under its MIT license, copyright 2026 Igor Warzocha, matching this repository's license. The package notice records the pinned revisions and inherited copyright holders.

## PR #552 refresh

Traced read-only Pi Stuff `a06eae4d..1338b66a1067c254fec46746ef96b6bd9456148b`. Shepherdr moves shared notes and history ownership from Codex Conversion to Notes, independently retaining Codex relationship metadata. Native Agents already delegates Context visibility through `assignContextVisibility` in the admission transaction and keeps provider identity separate. It does not relay Pi attachment receipts or reconstruct public content from private receipts. Context owns native history and saved notes, so the Pi relay import and alias-remapping changes introduce no Agents adapter.

The discovery change instructs process controllers to send `/quit` directly to finished panes. Native workers are Durable conversations, not Pi processes. Sending that string would create a new input rather than close a pane, so that host-specific instruction is excluded. Native help continues to distinguish send, delegation and watches. The source's rollover briefing identity now recognises Notes windows rather than requiring Conversion. No Pi window parser is carried here. Native task receipts, Fleet documents and Context visibility survive head replacement independently of Pi messages. This delta does not add a native supervised-worker rollover briefing or claim that a persisted Fleet is itself a model-visible briefing.
