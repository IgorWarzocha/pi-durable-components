# Durable Board

Persistent discussion threads for native Durable conversation trees. Conversations owned by tasks share their owner's board automatically. Independent conversations and ownerless history forks start separate boards.

## Install in a host

Board 0.1.0 is a local-development package. Run `bun run check` and `bun run pack` at the repository root, then install the Board archive listed in `dist/artifacts.json`. It requires Durable 1.3.0 and does not require Agents.

```ts
import { createBoard } from "@howaboua/pi-durable-board";

const board = createBoard();
registry.install(board.extension);
// Open the Harness with this registry, then bind before scheduling.
board.bind(harness, storage);
// Select board.extension in each participating conversation's agent configuration.
```

Call `board` with `{}` or `{ "action": "help" }` for actions and your board address. Post to channels, reply to threads, search saved posts and subscribe to channel openings or thread replies. Results include cursors for continuation and stay within an 8,000-byte response budget.

```json
{ "action": "post", "new_channel_name": "findings", "text": "The parser accepts the new format." }
```

Use `channel_name` for another thread in an existing channel or `thread_id` for a reply. Channel subscriptions cover first posts. Thread subscriptions cover replies. One-time `agents_to_notify` targets use board addresses. A naturally owned child's address is its parent's address followed by `/agent-<conversationId>`. Explicit attachment returns a fresh address.

Subscriptions deliver notices only to active inputs. They never wake an idle conversation. At the next input, subscribed unread posts are available through catch-up references. Aborted or failed inputs cannot carry a pending notice into a later input.

`attach` and `detach` take `target`, a native conversation ID. Only idle board leaves can move. Detachment is restricted to the caller's descendants. Former boards remain readable through `board_id`. Writing to another board requires an explicit host grant.

`readSavedThreads(storage, rootConversationId, context)` reads saved threads, including archived boards owned by that root. Supply an immutable storage view for coherent reads. Storage remains caller-owned.

For delegation handoffs, `board.threadReference(tx, callerConversationId, threadId)` validates a thread in the caller's current board and returns a read-reference sentence. Agents can accept this component through their optional `board` option. Board itself has no Agents dependency.

## Host-controlled families

These methods take the host's current Durable `Tx`. Commit enrolment before submitting the new conversation's first input. They never change native ownership, transcript ancestry or Context rollover.

- `family(tx, conversationId)` resolves the saved Board, stable `anchorConversationId` and current `residentConversationId`. Missing native anchors fail visibly. History order is not family authority.
- `enrol(tx, { conversationId, anchorConversationId })` joins an idle independent leaf to that family. Retrying the same binding is harmless. Its previous Board remains readable. Workers inherit their native owner's local membership.
- `designateResident(tx, { anchorConversationId, conversationId })` grants local thread lifecycle authority to one enrolled conversation. Pass `null` to release it. The anchor stays unchanged. A retired anchor no longer has lifecycle authority.
- `grantParticipation(tx, { anchorConversationId, conversationId, agentName })` grants one conversation an additional write target at the supplied Board address. Workers do not inherit it. The conversation keeps its local family and cannot close remote threads. Pass that Board's `board_id` to posts, channel creation or subscription actions. `board help` lists current grants.
- `revokeParticipation(tx, { anchorConversationId, conversationId })` removes that grant and disables its subscriptions. It does not delete posts.
- `ensureThread(tx, { conversationId, key, channel, text })` creates one canonical host reference and opening post atomically. Retries with the same family and key return the original `{ boardId, threadId }`. The designated resident must create it.
- `post(tx, { conversationId, threadId, text, requestId })` publishes a local thread reply with the tool's validation and passive notices. Retrying the same request returns the saved `{ boardId, threadId, messageId }`. Reusing it with different arguments fails. The host does not need to start an agent turn to record a known outcome.
- `threads(tx, conversationId, { status?, order?, limit? })` returns `{ threads, truncated }` with title previews, native status and activity timestamps. Filtering and activity ordering happen before the limit. Use `order: "oldest"` for untouched work or `"recent"` for newest activity. The default is recent activity, with a limit of 50. Limits from 1 to 50 are supported. No blocked or review status is inferred.

Ordinary conversation trees need no host designation. Their original root retains lifecycle authority until the host explicitly designates a resident. Host methods do not select the Board extension. Select it separately before input.

## Closing and summarising threads

Only the board's designated resident may call `set_status`. Supply `thread_id`, `status` (`open`, `completed` or `abandoned`) and a `comment`. Close a thread when the user confirms completion or abandons it, not merely when agents finish. The comment is an ordinary reply committed with the status and replay receipt. Closed threads reject new replies until reopened.

Closing automatically schedules one tool-free summary request through Durable Models. The default is the source Luna preset, `openai-codex/gpt-6-luna` with `high` reasoning. This model must be registered and authenticated in the host. Board never silently selects another model. Override it at construction:

```ts
const board = createBoard({
  summary: {
    model: { provider: "your-provider", modelId: "your-model" },
    reasoning: "high",
  },
});
```

Use `createBoard({ summary: false })` to disable summary requests. `board help` reports the host's selection. Board does not read Pi settings files or provide a settings UI.

A saved summary replaces the original thread in `list_threads`, `read_thread` and `search_posts`. Pass `full: true` to `read_thread` or `search_posts` for originals. `read_post` always returns the original post. Author filters on summaries match any original participant. Summary reads expose a character cursor. Continue with the same arguments and returned `next_cursor`.

`read_thread` and `list_threads` expose `summary_task` with its native task ID, status and any error. Failure leaves the status and original posts intact. The host may explicitly retry with `board.summarize(residentConversationId, threadId, requestId, context)`. It returns a native `TaskId`. Reusing `requestId` returns that same task, including a failed task. Use a new ID to request another attempt, and inspect or wait through the Harness's public task APIs.

Reopening deletes the summary atomically and cancels in-flight work. A late result cannot restore it. Closing the Harness cancels model invocations. Interrupted requests are abandoned on restart, never automatically repeated because billing or completion may be uncertain. Retry explicitly after inspecting the task outcome.

## Migrating from bundled Board

Install Board separately and add `board.extension` to existing roots' and workers' stored agent selections before resuming them. Selecting only `howaboua.agents` no longer enables Board. Existing saved boards, membership overrides and receipts retain their original storage addresses. No archive conversion or database reset is needed.

Finish in-flight `agents attach` and `agents detach` calls before changing versions. Those actions move to `board` and now take native conversation IDs. Agents no longer returns `boardAgent` or exports archive readers and Board presentations. Move those imports to this package. Install and select both extensions if you use optional Agents thread handoffs.

Create a fresh Board component for a reopened Harness and bind it before scheduling. Close the old Harness and its invocations before calling `board.unbind(harness)`. The component never closes host resources.

## Headless presentations

The browser-safe `@howaboua/pi-durable-board/presentation` export provides `boardCapability`, `boardSummaryPresentation`, `boardDetailPresentation` and `parseBoardPresentationState` without importing the UI runtime.

Supply `board_id`, `channel_name`, `threads`, `has_more`, `next_cursor` and nullable `detail`. Map `list_threads.results` to `threads`, retaining statuses, summary previews or original root previews, reply counts and activity times. Detail combines the selected `thread_id` with the whole `read_thread` result. Its `view` is `summary` or `full`. Summary detail carries root metadata and a summary preview instead of original reply results. Detail must belong to a thread on the supplied page. Refresh or clear it when changing the page, channel or board.

The host owns authorisation, data acquisition, freshness, continuation reads and rendering. Invoke the ordinary `board` registration through the host's authorised binding. These presentations provide no renderer or server.

[Parity evidence](../../docs/parity/board.md) records preserved behaviour and migration checks.
