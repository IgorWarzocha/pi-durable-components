# Pulses parity

The parser and schedule algorithms retain Clawa revision `07fbb0ad71a08a864b285b01d512c2052861b91d`. The 2026-10-19 alignment inspects `packages/pi-pulses` at Pi Stuff revision `7f3295e67a8e6146b2a6922b56a06fa4db5c3a32`. Both references are read-only; `packages/pulses/NOTICE` records attribution.

Semantic schedule changes now reset eligibility time and seed the current slot instead of running against stale recurrence state. Cosmetic schedule spellings and body edits preserve the checkpoint. Legacy checkpoints without a parsed schedule identity seed safely on discovery. Reconciliation preserves admitted tasks, current conversations and historical associations.

Native task inputs and submission receipts already own retry and deleted-definition responsibility. A failure before atomic admission leaves no task to duplicate. A repeated manual request rejoins its admitted task before checking the current definition, even after disablement or removal. Removal never deletes a pulse folder, conversation or history. Admitted work settles and reports passively to its captured parent; no second Shepherdr ownership ledger is introduced.

The task prompt carries the source's result guidance: put substantive results in the appropriate destination, return a brief pointer, keep procedural feedback separate, and do not edit the definition without explicit authorization. The accepted `pulses/<id>/PULSE.md` layout and local artifacts remain unchanged; source `.pi/pulses/<id>.md`, process fleet control and terminal presentation are not substituted for the native contract. The experimental PCC prose selector is excluded.

## Evidence

The whole-package audit against read-only Pi Stuff `12c4357b2c401fe9be8c6c82d2ae252c0f986937` found the ordinary source `pulses` registration missing from the scheduler-only extraction. The native extension now registers `{}` for discovery, `{run: "id"}` for immediate admission and `{skill: true}` for bundled portable authoring guidance. Authoring needs neither a host file path nor a binding resolver. Discovery and running require the caller's execution environment and explicit `resolveToolBinding`. Routing is memoised before admission, so replay cannot drift to another workspace.

The optional `withToolRunAuthorization` establishes a lazy host caller scope outside the portable queue. A receipt lookup happens before that scope and repeats inside the queue before current definition or admission policy. Actual authorisation belongs to `admit`, while race-safe policy and credit remain in `admitTransaction` with task creation. The public `PulseRunRequest` preserves the exact request identity for this scope. Hosts must not infer authority from request IDs or charge before rejoining an accepted receipt.

A disposable real-Harness probe called all three ordinary forms through the actual registration. It verified no binding lookup for bundled authoring, exact execution-environment binding, host-scope-before-portable-queue ordering by entering a second public queue operation, one admission transaction and receipt rejoining after deleting the definition. No permanent tests or live-provider calls were added.

A disposable real SQLite/Harness probe checked cosmetic versus semantic schedule changes, legacy current-slot seeding, failed-admission rollback followed by a successful retry, active-task and history preservation across schedule edits, removed-definition request rejoining, and exactly one passive parent result without waking a parent generation. It also captured the actual task prompt. No permanent tests were added. Existing ownership and cancellation evidence remains in the [package contract](../../packages/pulses/README.md).

## Assistant-first scheduling

The host integration extends the pinned source with a persisted due cursor, coalesced occurrence count and period, execution concurrency and explicit resident targeting. Counts begin at the new tracking cursor. Legacy checkpoints seed the current slot rather than inventing earlier missed work. Reconciliation accounts for the previous tracked schedule before recording removed, disabled, invalid, expired or superseded pending work as a disposition. Accepted native tasks retain their captured inputs and submission receipts.

Child execution remains the default. A resident target uses the host-supplied continuing conversation without applying child configuration or sending a passive report to itself. The injected occurrence period asks for one fresh run covering the missed work. Explicit jobs retain separate identities and queue oldest first under the persisted concurrency limit. Native generation retry deadlines can delay admission. They are not treated as proof of a provider rate limit, and settled failures are not replayed.

The optional host admission callback runs in the native task-creation transaction. It may read and write documents, but native table reads after task creation are forbidden. A blocked decision escapes the commit before being caught, rolling back task creation, configuration and host activity credit together. The later input-delivery port validates committed accepted-task lineage. Native request and submission receipt rejoining precedes new admission, so later restrictions do not strand accepted work or refresh its activity credit.

`bind` now returns an awaited reconciliation promise and does not resume the Harness or admit work during reconciliation. The host owns resume after all capabilities are bound. Existing checkpoint and task document versions remain unchanged, with additive optional fields for older tasks.

Construction evidence is source review, TypeScript, lint and supported build and package checks only. No tests were added or run, and no new live-provider or runtime acceptance is claimed. The probe evidence above remains historical.

## Pi 1.4 source alignment

Compared read-only Pi Stuff `3d0faf5a6f0bc67c0bd9248d07da6ddfa901b281` against `7f3295e67a8e6146b2a6922b56a06fa4db5c3a32`. The Pulses package changes only dependency metadata. Related Shepherdr changes mark process workers and reserve process names. Native task ownership and the existing host admission contract remain the component boundary, without a Pi event channel or process-runner adapter.

Durable 1.4 replaces invocation-held sleeps with `sleepUntil(until, checkpoint)`. A busy, unadmitted Pulse now checkpoints its dispatch phase and sleeps durably without retaining an invocation. The old retry phase remains registered to recover existing tasks. Abort remains immediate and cancels only a native run that owns the captured Pulse input, never the external work causing a busy rejection. Sleeping tasks remain active for concurrency, cancellation and execution observation. The checkpoints document declares a base after 64 accumulated deltas, preserving its kind and version.

A disposable real SQLite/Harness probe drove the production run task through a rejected native admission, observed its sleeping state and dispatch checkpoint, and cancelled it before the deadline with no input admitted. A second sleeper survived Harness and storage reopen without an early retry. Advancing the public Harness clock to its persisted deadline admitted exactly one native input and settled the original task. No task or side effect was recreated. Strict TypeScript passed against Durable, Pi AI and Chord 1.4.0. No permanent tests or live-provider acceptance were added. The coordinator owns the final repository gate.
