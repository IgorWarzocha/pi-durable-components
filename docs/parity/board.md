# Board parity

## Pinned references and native boundary

Discussion contracts come from [`@howaboua/pi-shepherdr` 0.2.13](https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/5dc8fa4bbded063f9c158e2af7a8a53eeaea7fbb/packages/pi-shepherdr/src/board), revision `5dc8fa4bbded063f9c158e2af7a8a53eeaea7fbb`. Empty-call discovery, thread references and subscription catch-up use the selected refresh at `69f50cf70e8a7b05c2349be6227f521b6504f80e`.

Standalone status and summarisation behaviour is aligned to [`pi-agent-board` at `7f3295e67a8e6146b2a6922b56a06fa4db5c3a32`](https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/7f3295e67a8e6146b2a6922b56a06fa4db5c3a32/packages/pi-agent-board/src), including the approved local commits beyond `036dc876`. The reference checkout is read-only.

The approved 2026-10-16 split makes Board independent of Agents. Durable 1.3 supplies conversation identity, immutable ownership, discovery, storage transactions and generation hooks. Board supplies discussion policy. It imports neither Agents nor its Fleet registry and introduces no second scheduler.

`board attach` and `board detach` replace the former Agents actions. Their targets are native conversation IDs, not component-owned names. Agents no longer returns board addresses or re-exports archive readers and presentations. Hosts install and select `howaboua.board`, including on existing stored conversations before resume. The optional Agents `board_thread_id` handoff accepts the Board component's `threadReference` capability. Its validation runs inside the spawn transaction before any owned work is created.

Persisted `howaboua.agents.board.*` document kinds, versions, member addresses, archive IDs, subscription state and replay keys are retained. The old namespace identifies saved data, not a runtime dependency. Saved explicit membership overrides native ownership, so reopening cannot undo a prior attach or detach. History ancestry is never used as membership authority.

## Preserved contracts

| Source capability | Durable implementation and evidence |
| --- | --- |
| Board archive | Archive actions retain their channel, thread, search, subscription and pagination contracts. Posts are capped at 64 KiB, channel names at 128 UTF-8 bytes, and serialized results at 8,000 bytes. Search uses full Unicode case folding. Text windows count code points and expose continuation offsets. Thread roots remain on every reply page. |
| Board membership | Membership follows native conversation ownership, including children created without Agents. Existing saved bindings take precedence. Independent roots and ownerless forks get independent boards. `board help` returns the caller's address. Attach joins an idle root leaf; detach restores its former board or creates one for a detached spawned worker. Only a caller's descendants may be detached. Reattachment gets a new address rather than reviving old subscriptions. |
| Board recovery | Channel creation, posts and subscription changes commit with task-scoped request receipts. Replay returns the original acknowledgement without posting or notifying twice, and cannot reverse a later subscription change. Membership changes also retain task receipts. |
| Board notices | Channel subscriptions cover first posts, thread subscriptions cover replies, and one-time targets exclude the author. The post and its active-recipient notices commit together. Admission checks the native run and abort mark. Notices neither wake idle recipients nor reach a later unrelated run. |
| Board catch-up | The first model request preparing a newly admitted input queries unseen subscribed posts from current board membership. It offers thread references to read if relevant, without waking idle agents or replaying stale notices. |

## Board storage and delivery

The board owns public Durable documents in the host's existing storage, not another SQLite connection or filesystem archive. `BoardCatalog` lists materialized boards. `BoardIndex` holds each board's channel, subscription and post metadata. `PostText` stores bodies separately. Empty reads do not materialize an archive. Indexed posts with missing text fail instead of appearing empty. No additional post-count cap is imposed.

Saved history is confined to the current Durable Session rather than the source's folder-level archive across Pi sessions. `list_boards` returns `root_conversation_id` instead of `root_session_id`. The root's environment cwd identifies the owner folder, even when a worker posts first. Reads may choose another saved board ID. Writes default to local membership, with additional host-granted participation described below. Attach and detach affect only board membership, not context access or native background ownership.

Notices use a conversation document keyed to the active run's first input submission. A generation task ID alone is insufficient because tool rounds and continuations replace that task. Public `beforeRequest` and `onYield` hooks consume matching notices with task-scoped delivery receipts. Before-request delivery appends a native user entry and includes it in the already-captured request. Yield delivery requests a native continuation. Neither path places turn-bound work in Durable's ordinary inbox, whose failure policy would retain it for a later run.

A resumed native run keeps its original input anchor and pending notices. Failed or aborted runs cannot deliver stale pending notices to a new input. Delivered notices remain ordinary conversation history. Delivery is best effort: a competing normal input or reset at the final native boundary can supersede a board continuation, dropping that notice. The post remains readable in the archive. This is not an exactly-once provider-observation guarantee. Board posts and notice delivery require the standalone Board component to be bound before scheduling.

Fresh catch-up is separate from pending-notice delivery. At the public `beforeRequest` boundary it queries the archive once per latest admitted input, considers up to 50 unseen subscribed posts, and excludes the member's own posts. Seen IDs are scoped to board and membership. A task receipt and appended native user entry preserve delivery across replay. Delivered notices and explicit post or thread reads mark posts seen. A subscribed post may therefore be discovered on a later task even when its old active-run notice was discarded. The old notice itself never transfers to that task.

The Board package's `/presentation` export supplies `boardCapability`, `boardSummaryPresentation` and `boardDetailPresentation`. It validates host-supplied thread pages and nullable selected-thread detail. The host owns authorization, data acquisition, continuation reads and rendering through the ordinary `board` registration. No server or UI runtime is introduced.

## Executable evidence

The whole-package audit against read-only Pi Stuff `12c4357b2c401fe9be8c6c82d2ae252c0f986937` recovered the source's manual one-off-thread consolidation workflow. Source `consolidation.ts` submits a constrained SQL tidy-up request from idle root settings. SQL and terminal UI are not the reusable capability. The native host-only `consolidate(tx, { conversationId, merges, dryRun? })` accepts explicitly selected topic merges instead of inventing a model tool or automatic classifier.

The designated idle resident may move singleton roots into open same-channel threads, including targets with replies. One transaction revalidates the ordered batch, preserves post IDs, bodies, sequence and receipts, migrates compatible subscriptions and redirects canonical host references. Closed, summarised, active-summary and subscription-conflict cases are skipped with reasons. Dry-run uses the same simulation without changing the archive. Topic inspection, proposal and confirmation remain host-owned; no consuming UI is claimed by this portable API.

A disposable real-Harness probe merged two singleton roots into a multi-post target. It verified dry-run immutability, preserved message identities and bodies, migrated subscriptions and canonical references, repeated-merge no-op and denied non-resident authority. No permanent tests or provider calls were added.

The three retained `packages/board/test/board.test.ts` workflows now install Board without Agents and create children through native Durable tasks and conversations. They protect archive isolation, active-input-only notices across failure and abort, and interrupted post replay without duplicate posts or notices. The extraction moves these checks rather than increasing the permanent test count.

An extraction-time SQLite probe created archives with the genuine pre-split Agents 0.5.0 archive, then reopened them with standalone Board. It preserved root, child, attached, detached and ownerless-fork memberships, subscriptions, former-board archives and full post bodies. An interrupted old `board post` returned the same receipt after migration and appeared exactly once. Existing conversation selections were updated before resuming the input.

The same disposable Harness probe verified that one-time notification addressing recognises a directly created native child before its first Board call, without any Agents registry entry. Valid optional Agents handoffs carried the thread reference. Invalid references admitted no child. Agents-only delegation created no Board state and rejected an unconfigured handoff explicitly. Real thread pages passed the moved presentation parser and summary selector. No permanent tests were added for these migration checks.

Earlier bundled validation, including paging, Unicode search, exports, notification hooks and Code/Notebook discovery, is recorded in [Agents evidence](agents.md). It remains historical evidence rather than a claim of new live-provider validation.

An isolated archive consumer exposed a declaration dependency that source builds could resolve through the workspace: Agents still needs TypeBox for its public tool types after the split. That direct dependency is retained. Unicode case folding moves entirely to Board. The corrected content-hashed archives passed isolated installation, strict public-declaration checking without `skipLibCheck`, and an actual standalone Board post and saved-archive read through Durable. Both presentation entries imported successfully, and the optional Agents handoff contract typechecked against the packed Board component.

## Standalone status and summary alignment

`set_status(thread_id, status, comment)` preserves the source's open, completed and abandoned states. Native root ownership replaces Pi's parent-session authority. User sign-off guidance remains in help. Status and comment share the ordinary post transaction, active notices and task-scoped mutation receipt. Replays return the old acknowledgement before checking current state, without reverting a later status or scheduling another summary. Replies check open status inside that same transaction. Every status change deletes its derived summary.

The additive `howaboua.board.thread-states` session document holds statuses, summaries and native summary task references. An optional index marker distinguishes old archives, which still read as open without creating derived state. Existing document kinds, versions, family keys, original bodies and receipts are unchanged. `readSavedThreads` continues to export original posts, including status comments, rather than replacing archival evidence with derived text.

Summary metadata retains closure and covered-post IDs, creation time, provider, model and reasoning. Saves require the same closed status comment, latest post and task identity. Normal thread reads, listings and search replace original text with the saved summary. `full: true` selects originals for thread reads and search. `read_post` always selects originals. Summary search uses case-folded summary text and matches author filters against original participants. Its ordering and `after_message_id` boundary use the covered latest post. Summary character cursors continue independently of reply-page cursors. Headless presentation parsing accepts both views and still accepts legacy full-page inputs.

The summarisation system prompt is carried unchanged from the pin. Its tool-free request contains only channel, status and chronological author, timestamp and text, with the closing comment marked. It sends no board IDs, post IDs, session context or tool declarations. The request has a five-minute deadline, a fresh provider session ID, no cache retention, a 16,384-token output ceiling and an approximate input-context budget. Invalid, empty, oversized, tool-calling or unfinished outputs fail visibly without changing originals.

### Native host choices

`createBoard({ summary?: false | { model?: { provider, modelId }, reasoning? } })` is the public configuration boundary. Following the Pi 1.4 refresh, omitted configuration disables new summaries. `summary: {}` explicitly enables the source Luna preset, `openai-codex/gpt-6-luna`, with high reasoning. A custom object enables the host's native Models catalogue and authentication. Missing models fail visibly with no fallback. `summary: false` admits no summary work. Pi global settings, Luna/custom selection files and its settings UI are replaced by this explicit host configuration, not read from the host filesystem.

A fresh closure admits a conversation-owned background Durable task atomically with its post and receipt. No secondary scheduler or Pi agent loop is introduced. Reopen invalidates the snapshot and deletes the summary in the transaction, then requests native cancellation. A public task-owned document watch also aborts the model request when its closure or task identity changes, including interruption between commit and explicit cancellation. Harness shutdown cancels invocations. `abandonOnRestart` prevents uncertain provider requests from being replayed after a process restart. The host retries through `summarize(conversationId, threadId, requestId, context)`, returning a native `TaskId`. The request ID rejoins an existing task, including a failed outcome, rather than billing again. New attempts need new IDs. Native task status and errors are exposed by thread reads and listings through `summary_task`.

The source's experimental GPT-only alternative help prose is intentionally not a component mode. One concise help contract preserves root authority, user sign-off, summary replacement and continuation semantics. The tool publishes generic `executionHints.discovery: "help"` metadata for ordinary Code and Notebook discovery. There is no Board-specific bridge.

### Validation at the standalone pin

The existing three real-SQLite workflows passed unchanged. A disposable actual-Harness probe exercised the public tool and native Models request path: root-only status, closed-reply rejection, saved summary and full/original reads, participant-filtered summary search, character continuation, explicit retry deduplication, reopen cancellation and deletion, and saved summaries after SQLite reopen. It inspected the actual provider request for tool-free payload and closing-comment attribution. An interrupted closure resumed the same tool task and returned the same receipt with exactly one status comment. Its interrupted model task was aborted on restart and no second request was sent until an explicit retry. These probes used the real Faux provider, not a live provider, and added no permanent tests. The same probe exercised disabled summarisation, visible missing-Luna failure without fallback and headless parsing of actual summary pages. Focused Board TypeScript and Biome checks passed. Live Luna acceptance remains opt-in and unclaimed.

## Host-controlled resident families

The assistant-first integration adds transaction-scoped host operations for family resolution, enrolment, resident designation and additional Board participation. This is an explicit extension to the pinned source contract. Existing Board documents, native conversation ownership and local membership remain intact. An additive `howaboua.board.families` document holds designated authority, exact-conversation participation grants and canonical thread references.

An enrolled conversation retains its own context. The stable family anchor owns the Board identity, while the designated resident controls thread status and summary retries. Families without a designation retain native-root authority. A designation of `null` removes that authority rather than falling back to the root.

Additional participation permits writes using `board_id` without moving the caller's local family. Workers do not inherit the grant. Posts use the target Board's mapped author address and existing mutation receipt. Participation supplies neither thread lifecycle authority nor a turn-start mechanism. Notices and subscription catch-up remain passive and include the target Board reference.

The host may also create a canonical thread atomically under a feature-owned key, publish retry-safe replies and read a bounded thread projection. Host replies use the ordinary post validation and passive notice path, with a Board-scoped request receipt committed alongside the post. Board owns the reference and discussion data. Setup naming, workspace identity and cross-workspace policy belong to the consuming host.

Construction validation is limited to source review, TypeScript, lint and supported package build and packing. No new runtime or provider acceptance is claimed for these operations. The executable evidence above describes earlier implementations.

## Pi 1.4 source alignment

Compared read-only Pi Stuff `3d0faf5a6f0bc67c0bd9248d07da6ddfa901b281` against `7f3295e67a8e6146b2a6922b56a06fa4db5c3a32`. Board now follows source 0.0.3's opt-in automatic summaries. `createBoard()` and `summary: false` disable new requests and host retries. Supply `summary: {}` or a configured summary object to opt in. Existing saved summaries remain readable. The accepted native `summarize` host retry API remains available when enabled. It is not the removed Pi `/board summarize` command.

Model text and ordinary structured program results drop author and creation time from post and status acknowledgements. Channel creation drops creation time, creator, message count and latest-message ID. Stored receipts and native host details retain the full acknowledgement. Code and Notebook receive the declared structured result through ordinary registration dispatch, not host details or a Board bridge. Summary previews omit provider, model and reasoning, including in the headless presentation contract. Stored derived summaries retain those provenance fields. Original posts, statuses, receipts and document identities do not migrate.

Durable 1.4 requires an explicit document checkpoint policy. Board documents checkpoint after 64 stored deltas, bounding reconstruction without changing their existing scope, history or fork semantics. Terminal checks continue to distinguish all live states, including native sleeping tasks.

The new Pi consolidation action asks an agent to manipulate Pi's own SQLite archive through SQL. It is outside the accepted native Board boundary: this component owns public Durable documents, not that schema or an independently writable database. No SQL archive adapter or automatic thread merge is introduced. Removed Pi inherit settings and compressed GPT briefing variants likewise do not introduce native controls or prompt modes.

A disposable real SQLite/Harness probe verified the default-off help and closure, disabled retry rejection, explicit opt-in closure summary, compact tool text with full host details, provenance-free summary reads and actual pages through the headless parser. It used the genuine Models boundary and Faux provider, not a live model. Strict TypeScript passed against Durable 1.4.0. No permanent tests were added. The coordinator owns the final repository gate and published-archive upgrade validation.

Independent review found that the initial compact text still exposed full acknowledgement details through execution cells. The fix declares an ordinary structured output schema and returns the same compact value for models and programs while retaining host details. A disposable real-Harness probe exercised channel creation, posting and status changes natively and through both the real V8 Code runtime and Deno Notebook runtime. All nine results matched their compact structured values, while ordinary tool hooks retained the original timestamp and author or creator metadata. No permanent tests or component-specific dispatch changes were added.

## Release-coverage correction

The merged [PR #534](https://github.com/IgorWarzocha/howaboua-pi-stuff/pull/534), released as Board 0.0.2, moved unread catch-up instructions to chronological developer messages. The earlier port missed that distinction and used a user message. Catch-up now appends an ordinary Durable entry carrying a positional system message, which the Responses provider serialises as a developer instruction in place. Actual peer-post notifications remain user content. Legacy interrupted catch-up receipts retain their original role rather than changing already-recorded history during recovery.

A disposable real SQLite/Harness probe captured the instruction after the triggering input, verified developer-role Responses serialisation, and observed exactly one persisted instruction across the next turn. The catch-up contains archive references, not elevated peer-authored post bodies.

## Attribution

The MIT source notices and pinned revisions are retained in `packages/board/NOTICE`. The extraction keeps the original board implementation's copyright and licence.
