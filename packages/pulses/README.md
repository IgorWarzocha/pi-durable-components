# Pulses

Persistent, folder-owned scheduled work for Pi Durable. Each `pulses/<id>/PULSE.md` stays beside its local instructions, journals and artifacts. Removing a definition or this component never deletes that folder or native conversation history.

```sh
npm install https://github.com/IgorWarzocha/pi-durable-components/releases/download/v0.8.1/howaboua-pi-durable-pulses-0.8.1.tgz
```

```markdown
---
title: Weekly review
schedule: weekly fri 17:00
enabled: true
quietHours: 22:00-08:00
---
Review this workspace. Follow the instructions in this pulse folder and update its existing journal.
```

Schedules support `manual`, `every 30m`, `every 3h`, `every 2d`, `daily 9:00`, `weekly mon 9:00` and `at <datetime>`. Times use the runtime's local timezone. Scans run every five minutes. New, reenabled or semantically changed schedules seed the current slot rather than replaying stale work. Cosmetic spellings and body edits preserve recurrence state. Quiet hours hold due work. Disabled definitions cannot run manually. A manual invocation bypasses quiet hours without consuming its recurrence checkpoint. Established `trigger: manual` and `trigger: time` headers are accepted. Unknown metadata is left untouched.

Tracked occurrences survive a host-imposed pause and process downtime. Each job coalesces its pending occurrences into one fresh run with the count and first/last due timestamps in its input. Tracking begins on discovery or upgrade, without guessing missing legacy history. Deleted, disabled, invalid, expired or superseded pending work remains inspectable as a disposition rather than running an obsolete definition. Optional `expiresAt: <datetime>` stops new admissions at that deadline. Already accepted work still settles.

Child execution remains the default. Set `target: resident` to deliver into the continuing conversation explicitly supplied by the host binding. The resident keeps its own configuration and reports through its ordinary conversation. Changing the target seeds a new schedule without replaying the old target's pending work.

## Integration

Install `createPulses(options).extension` before opening the Harness, then await `bind(harness, context)` before recovering other proactive sources. Binding reconciles definitions and checkpoints without admission or execution. After all features bind, the host calls `scan(context)` and resumes its Harness. Pulses never resumes it. Provide explicit workspace bindings and environment-owned definition reads. Prepare filesystem/configuration data in `admit`. `configure` performs document-only native transaction operations on every new child admission. Its fifth argument, `{created}`, distinguishes initialization from reuse. Apply standalone host defaults only on creation. Refresh applicable pulse-local instructions and cwd without resetting native models/tools/extensions on reuse. Parent configuration inherits natively. Resident targets bypass `configure`.

Supply `admitTransaction(tx, admission, context)` for host-owned race-safe policy and activity accounting. It receives the new native task ID in the same commit as task creation. Return `{status: "accepted"}` or `{status: "blocked", reason, retryAt?}`. Blocking rolls back the entire transaction, including host credit, and leaves the occurrence queued. Only `tx.doc` operations are supported here. Native table reads after task creation are forbidden, as are Harness reads, external I/O and irreversible effects. Rejoining an existing native request skips new-admission policy. `explicitReady(tx, bindingKey, now)` exposes tracked pending or overdue work for shared admission priority without reading files. Work held by Pulse quiet hours or a recorded native backoff deadline does not claim that priority.

The optional `submitInput` port receives the accepted native task ID, target, content and deterministic input request ID. Validate that task's lineage before delivering accepted work through the host. Return the actual settled native input receipt. The coordinator rejoins an existing receipt before calling this port. Previously admitted native tasks remain valid even if their definition disappears or restrictions change.

`catalog(context)` returns definitions and inspectable diagnostics. `run({bindingKey,pulseId,requestId}, context)` returns the native task ID, or `undefined` when admission is blocked or capacity is occupied. Use a stable request ID for retries. `observe(context)` includes pending counts/periods, blocked reasons, the last obsolete/superseded disposition, historical conversation associations and the current native task record, including removed definitions. Outcomes and submissions remain native. `stop` aborts and joins the native coordinator. Its abort handler cancels only the run owning the pulse's input and settles its passive report. It does not cancel external work blocking a dispatch retry or a later run following pulse settlement.

The extension registers the ordinary `pulses` agent tool. `{}` lists definition paths and diagnostics, `{run:"name"}` requests a run, and `{skill:true}` returns bundled authoring guidance without filesystem access or a host binding. For discovery and new manual requests, supply `resolveToolBinding(api, context)` returning the authorised binding key for `api.conversationId` in `api.env`. Select the registration on the intended controllers. Discovery reads only that binding's definitions. Code and Notebook discover the same registration automatically. An admitted tool request freezes its binding in a native memo and uses the native tool task ID for deduplication. Recovery rejoins the existing receipt before reading changed definitions or applying new admission policy. Cancelling the calling tool does not revoke accepted background work. Use `stop` to cancel the owned pulse execution.

Hosts that scope manual admission to the invoking caller can supply `withToolRunAuthorization(api, request, run, context)`. Its `request` is the public `PulseRunRequest` with `bindingKey`, `pulseId` and the original `requestId`, identical to direct `run()` input. This wrapper runs after native receipt lookup finds no accepted request and outside the Pulses admission queue. Establish invocation scope only, call the supplied `run()` at most once and return its result. Defer actual authorisation to `admit`: queued execution rejoins receipts again before admission. This preserves host-scope-before-Pulses-queue ordering across UI and tool callers. Keep policy and credit consumption in `admitTransaction`, in the same native commit as task creation. Do not infer authorisation from request IDs. Existing direct `run()` callers retain their own host-authorisation boundary.

Execution concurrency defaults to two live Pulse coordinators, including accepted tasks recovered after restart. Different jobs queue oldest first and capacity is released after settlement. `setConcurrency(limit, context)` persists a positive integer limit. `configuration(context)` reads it. The initial `options.concurrency` applies only before a persisted limit exists. Native structured generation backoff deadlines delay further admissions. Other failures are reported, not reclassified as rate limits or replayed.

Each child pulse reuses one conversation. An actual optional-parent ID change creates one replacement after prior responsibility settles, preserving both histories and the same folder. Moving a binding's root with the same parent refreshes configuration and the current conversation's path association, not its identity. Prior replacement conversations keep their historical associations. No files are moved or deleted. Child completion writes passive context to the parent captured at admission, never an input or follow-up. An optional `writeResult` formatter receives the native outcome, title, answer text and deterministic request ID. It must return the settled native write receipt, which the coordinator persists in its native memo before finishing. Standalone results remain in the pulse conversation.

On removal, stop admissions and drain/close the Harness's native task invocations before awaiting `unbind()`. Keep the binding available while admitted settlement tasks run. The component owns its timer, not the host Harness. Interrupted side effects are not replayed by this scheduler; native submission receipts remain authoritative.

## Operational skill

The tool provides authoring guidance on demand through `{skill:true}`, outside the standing skill catalogue. The package also ships `skills/pulses-ops/SKILL.md`. `pulsesSkill(filePath, baseDir)` remains available for hosts that explicitly use the Skills catalogue. Supply the actual installed, execution-environment-visible asset paths for that descriptor; remote environments require explicit mounting. There is no implicit npm skill discovery or host filesystem escape.

## Source parity

The frontmatter parser and original schedule helpers come from Clawa revision `07fbb0ad71a08a864b285b01d512c2052861b91d`. See `NOTICE`. Quoting/booleans, supported duration units, local-time slots, initial-slot seeding, quiet-hour holding and manual checkpoint bypass retain those semantics. Durable cursor accounting adds coalesced missed periods and counts local calendar slots across daylight-saving changes. The `trigger` aliases, optional expiry and resident target are supported additions. Native atomic admission, persistent conversation reuse and passive result receipts replace Clawa's process-local execution transport. Files are never rewritten or relocated. Clawa's literal-ID collision policy is not carried across.
