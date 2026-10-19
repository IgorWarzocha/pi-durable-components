# Pulses parity

The parser and schedule algorithms retain Clawa revision `07fbb0ad71a08a864b285b01d512c2052861b91d`. The 2026-10-19 alignment inspects `packages/pi-pulses` at Pi Stuff revision `7f3295e67a8e6146b2a6922b56a06fa4db5c3a32`. Both references are read-only; `packages/pulses/NOTICE` records attribution.

Semantic schedule changes now reset eligibility time and seed the current slot instead of running against stale recurrence state. Cosmetic schedule spellings and body edits preserve the checkpoint. Legacy checkpoints without a parsed schedule identity seed safely on discovery. Reconciliation preserves admitted tasks, current conversations and historical associations.

Native task inputs and submission receipts already own retry and deleted-definition responsibility. A failure before atomic admission leaves no task to duplicate. A repeated manual request rejoins its admitted task before checking the current definition, even after disablement or removal. Removal never deletes a pulse folder, conversation or history. Admitted work settles and reports passively to its captured parent; no second Shepherdr ownership ledger is introduced.

The task prompt carries the source's result guidance: put substantive results in the appropriate destination, return a brief pointer, keep procedural feedback separate, and do not edit the definition without explicit authorization. The accepted `pulses/<id>/PULSE.md` layout and local artifacts remain unchanged; source `.pi/pulses/<id>.md`, process fleet control and terminal presentation are not substituted for the native contract. The experimental PCC prose selector is excluded.

## Evidence

A disposable real SQLite/Harness probe checked cosmetic versus semantic schedule changes, legacy current-slot seeding, failed-admission rollback followed by a successful retry, active-task and history preservation across schedule edits, removed-definition request rejoining, and exactly one passive parent result without waking a parent generation. It also captured the actual task prompt. No permanent tests were added. Existing ownership and cancellation evidence remains in the [package contract](../../packages/pulses/README.md).
