# Agents parity

## Pinned references and approved scope

The source is [`@howaboua/pi-shepherdr` 0.2.12](https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/b2006db9def12c373ae48e70044d30f7d6b7e34f/packages/pi-shepherdr), revision `b2006db9def12c373ae48e70044d30f7d6b7e34f`. Its `agents-tool.ts`, `agents-contract.ts`, `agents-discovery.ts`, `agents-spawn.ts`, `agents-work.ts`, and monitoring owners establish the action, delegation, delivery, and watch contracts.

The Durable reference is revision `f5d20047b3ad43d068a8eb61bd4e1f193bedbce6` of [earendil-works/pi](https://github.com/earendil-works/pi/tree/f5d20047b3ad43d068a8eb61bd4e1f193bedbce6/packages/durable). [Example 22](https://github.com/earendil-works/pi/blob/f5d20047b3ad43d068a8eb61bd4e1f193bedbce6/packages/durable/test/examples/22-subagent-foreground.ts) establishes safe tool replay and child-input request IDs. [Example 23](https://github.com/earendil-works/pi/blob/f5d20047b3ad43d068a8eb61bd4e1f193bedbce6/packages/durable/test/examples/23-subagent-background.ts) establishes background anchors and idempotent report submissions. Implementation uses the installed public Durable 1.0.2 API, not private imports. Reference checkouts were read-only during implementation.

Igor explicitly selected Durable-native delegation, profiles, messages, blocking and asynchronous results, and watches. He excluded Herdr machine, pane, process, SSH and terminal integration, shared-context and board attachments, and Ask answer actions. There are no built-in review or btw workflows. Those exclusions are scope decisions, not missing implementations awaiting a host adapter.

## Preserved contracts

| Source capability | Durable implementation and evidence |
| --- | --- |
| `help` and profiles | Help describes the actual action arguments and configured profile descriptions. Host profiles are named `AgentChange` configurations with the same blocking-policy precedence. |
| `list`, `find` | Session-wide component registry, stable conversation IDs, unique names and labels, case-insensitive query and native idle or working state. Pages contain at most 30 workers with `nextOffset`. Discovery covers component-created conversations, not an external process fleet. |
| `spawn` | One atomic commit creates the background anchor, child conversation, profile configuration, registry record, dispatch task, and completion reporter. Labels retain the two-or-three-word rule. Derived names retain slug normalization, collision suffixes and the 32-character bound. |
| `assign` | Sends an attributed task to an existing worker with a fresh task-scoped dispatch. Blocking defaults true. A self-delegation is rejected instead of deadlocking. |
| Blocking completion | Waits for the admitted child submission, returns its real answer entry's text, and suppresses an asynchronous echo after the blocking tool completes. Worker failure returns failed status, reason and detail with `isError`. |
| Asynchronous completion | Returns durable continuation IDs immediately. The background completion task waits for one delegation and submits its outcome to the controller after the controller can already have replied. Multiple requests answered by one assistant entry share one successful report ID. |
| `send` | Idempotent attributed native input admission, using `whenBusy: "steer"`. Starts idle recipients and steers active ones. No waiter, delegation record, completion reporter, or implicit watch is created. Durable itself may start a generation task. |
| `watch` | Explicit persistent background task, separately keyed by controller and target. Reconciles native input submissions, retains already-admitted pending input IDs, and waits for actual settlement across generation successors. Finished delegation reporters are not revived as persistent watches. Shared answers deduplicate by answer entry and shared failures by input ID. |
| `unwatch` | Removes membership without stopping the worker. The watch wakes and terminates even when its observed worker is still running. Replaying an older watch or unwatch call returns its saved receipt and cannot reverse a newer membership change. |
| `read` | Newest assistant or recent transcript data, backward paged scans rather than loading the whole transcript. At most 100 entries and 36,000 text characters per result. Explicit entry and offset retrieval preserves access to truncated text. |
| Cancellation | Blocking cancellation detaches the caller while worker ownership remains behind a background anchor. Eventual completion reports after the cancelled tool settles. Host background-inclusive abort reaches workers, dispatches, reporters and watches. |
| Restart | Tool-call identity records prevent duplicate spawn or assign effects. Worker input, send, and report request IDs prevent duplicate admissions. Durable checkpoint phases retain the report before delivery. Document watch handles are reacquired, not serialized. |

## Native differences within the approved boundary

- `target` is a Durable conversation ID rendered as a string, not a machine-qualified pane ID. Registered names are unique across one Harness. Numeric names are rejected so names cannot shadow stable IDs. Hosts can address an existing unregistered conversation by exact ID, but discovery lists only component-created workers.
- Profiles are supplied by the host. They are not process launch arguments, remote preparation scripts, or an implicit copy of a named built-in source profile. `cwd` stays within the host's execution environment. The excluded review `base` argument and layout fields are absent.
- Discovery reports native idle or working state from `LiveDoc.run`. There is no invented Herdr blocked, done, or unknown process state. Delegation receipts report done or failed. Native tasks waiting on tools remain pending work. Ask and terminal-derived blockage reports are deliberately absent.
- Source terminal `visible` and `recent` reads are not carried over. `recent` here is explicitly a transcript page. `latest` is bounded output from the actual newest assistant entry. Continuation fields expose omitted data rather than silently reducing a reply.
- Source Pi command dispatch is excluded with the Pi process integration. A leading slash is literal task input. This component registers no Pi commands or TUI surfaces.
- Report delivery uses Durable's ordinary input-submission boundary with `whenBusy: "followUp"`, as in example 23. The source's Conversion-specific prepared-turn staging cannot be imported. No synthetic assistant entry is used. Durable's queued-input abort semantics can withdraw an already admitted report. A withdrawn report is not replayed under a new request ID.
- Worker configuration inherits Durable's normal stored-agent copy. The host explicitly limits child tools and extensions if needed. There is no compatibility emulation of `ExtensionAPI`, and no component-specific Code or Notebook bridge.
- The host calls `bind(harness, storage)` after opening and before scheduling, using the exact public Harness and storage passed to `Harness.open`. Pending watches reacquire these capabilities on every reopen. Storage supplies bounded historical input scans, and `Harness.submission(id).wait()` supplies real settlement. Generation-task completion alone is not a completion signal because Durable also completes generations when transferring a run to a successor.

## Executable evidence

`packages/agents/test/agents.test.ts` runs native Harness, registry, tasks, MemoryStorage, file-backed SQLite, and pi-ai's public faux provider. It tests production tool calls rather than substituting a mock `ToolExecutionApi`.

The focused suite covers blocking reply and profile configuration, profile-enforced asynchronous behavior, message-only sends to busy and idle recipients, cancelled blocking waiters, background-inclusive ownership, safe blocking-tool replay, asynchronous delivery across repeated reopen, persistent watch recovery and unwatch while busy, failure detail, bounded text continuation and entry pagination, and rejected excluded actions before side effects. A 70,010-character blocking reply verifies that Durable's default tool truncation does not silently shorten delegated results. Latest-read scans also cross a page containing only later passive notes. Recovery caught a transaction-draft escape on the saved-receipt path. The corrected path copies receipt fields before leaving the transaction.

Independent review reproduced an idle-wake task fault and false completion reports for intermediate tool-calling assistant entries. Two added regressions fail on the original watcher. Idle document wakes now reconcile again in the same invocation rather than returning an unchanged checkpoint. The idle-wake regression covers unrelated Fleet changes and host-created peers whose inputs lack request IDs. Watching input settlement avoids false completion during tool rounds and `onYield` continuations while retaining legitimate terminate and handoff answers. The tool-round regression closes and reopens SQLite while the watcher waits. These checks use message-only sends, so a delegation reporter cannot mask a broken watcher. Regressions assert report content and the watch's durable outcome, not only `onReport` callbacks.

The emitted tool schema is 2,344 UTF-8 bytes and the description is 46 bytes. The extension adds no prompt sections. Action details and profile descriptions are returned by help, not injected into every request.

Validation: `node --test packages/agents/test/agents.test.ts`, 12 passing contracts. Strict TypeScript checking reports no errors in `packages/agents` with `exactOptionalPropertyTypes` and `.ts` local imports. Root workspace installation, manifests, aggregate validation, and Git operations belong to the coordinating agent.

Native model-provider side effects retain Durable's own interruption and generation-recovery semantics. These tests do not claim that a provider request is exactly-once or that remote terminal state survives a restart.

## Attribution

Background ownership and report submission patterns adapt Durable example 23 under its MIT license. The upstream copyright and permission notice are retained in `packages/agents/src/tasks.ts` and the published `packages/agents/NOTICE`. Shepherdr's contract and name-normalization behavior are used under its MIT license, copyright 2026 Igor Warzocha, matching this repository's license. The package notice records both pinned revisions and inherited copyright holders.
