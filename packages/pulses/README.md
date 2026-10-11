# Pulses

Persistent, folder-owned scheduled work for Pi Durable. Each `pulses/<id>/PULSE.md` stays beside its local instructions, journals and artifacts. Removing a definition or this component never deletes that folder or native conversation history.

```markdown
---
title: Weekly review
schedule: weekly fri 17:00
enabled: true
quietHours: 22:00-08:00
---
Review this workspace. Follow the instructions in this pulse folder and update its existing journal.
```

Schedules support `manual`, `every 30m`, `every 3h`, `every 2d`, `daily 9:00`, `weekly mon 9:00` and `at <datetime>`. Times use the runtime's local timezone. Scans run every five minutes. Newly discovered or newly reenabled scheduled definitions seed the current slot rather than replaying stale work; quiet hours hold due work. Disabled definitions cannot run manually. A manual invocation bypasses quiet hours without consuming its recurrence checkpoint. Established `trigger: manual` and `trigger: time` headers are accepted; other triggers are diagnosed. Unknown metadata is left untouched.

## Integration

Install `createPulses(options).extension` before opening the Harness, then call `bind(harness, context)`. Provide explicit workspace bindings, environment-owned definition reads and admission authorization. `configure` performs only native transaction operations on every new admission; prepare filesystem/configuration data in `admit`, which immediately precedes it under single-flight admission. Its fifth argument, `{created}`, distinguishes initialization from reuse. Apply standalone host defaults only on creation; refresh applicable pulse-local instructions and cwd without retaining stale copies or resetting native models/tools/extensions on reuse. Parent configuration inherits natively.

`catalog(context)` returns valid definitions and inspectable diagnostics. `run({bindingKey,pulseId,requestId}, context)` returns the native task ID, or `undefined` when the pulse already has active responsibility. Use a stable request ID for retries. `observe(context)` returns scheduling references, historical conversation associations and the current native task record. Outcomes and submissions remain native; no transcript or result database is maintained. `stop` aborts and joins the native coordinator: its abort handler cancels the run owning the pulse's input and passively reports the native submission outcome, or the native task's abort when stopped before dispatch. It does not cancel external work blocking a dispatch retry or a later run following pulse settlement.

Each pulse reuses one conversation. An actual optional-parent ID change creates one replacement after prior responsibility settles, preserving both histories and the same folder. Moving a binding's root with the same parent refreshes configuration and the current conversation's path association, not its identity; prior replacement conversations keep their historical associations. No files are moved or deleted. Completion writes passive context to the parent captured at admission, never an input or follow-up. An optional `writeResult` formatter receives the native outcome, title, answer text and deterministic request ID; it must return the settled native write receipt, which the coordinator persists in its native memo before finishing. Standalone results remain in the pulse conversation.

On removal, stop admissions and drain/close the Harness's native task invocations before awaiting `unbind()`. Keep the binding available while admitted settlement tasks run. The component owns its timer, not the host Harness. Interrupted side effects are not replayed by this scheduler; native submission receipts remain authoritative.

## Operational skill

The package ships `skills/pulses-ops/SKILL.md`. `pulsesSkill(filePath, baseDir)` returns a descriptor compatible with the existing Skills catalog. Supply the actual installed, execution-environment-visible asset paths; remote environments require explicit mounting. There is no implicit npm skill discovery or host filesystem escape.

## Source parity

The frontmatter parser and schedule algorithms come directly from Clawa revision `07fbb0ad71a08a864b285b01d512c2052861b91d`; see `NOTICE`. Quoting/booleans, supported duration units, local-time slots, initial-slot seeding, quiet-hour holding and manual checkpoint bypass retain those semantics. The established `trigger` aliases are a bounded import addition. Native atomic admission, persistent conversation reuse and passive result receipts replace Clawa's process-local execution transport; files are never rewritten or relocated. Clawa's literal-ID collision policy is not carried across.
