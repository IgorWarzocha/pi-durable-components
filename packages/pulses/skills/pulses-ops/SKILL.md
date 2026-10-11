---
name: pulses-ops
description: Manage folder-owned pulses and inspect native scheduled work.
---

# Pulses

Keep each pulse in `pulses/<id>/PULSE.md`, using a kebab-case directory name. Preserve its `AGENTS.md`, existing `runs/` journals and other artifacts. Read applicable workspace and pulse-local instructions before working. Native cwd remains the workspace root; use the explicit pulse-home path for local files. Do not invent an app-managed output directory or universal journal schema.

The small frontmatter parser accepts `title`, `schedule`, `enabled` and optional `quietHours`; leave unrelated keys, comments and body conventions alone. Schedules are `manual`, `every 30m`, `every 3h`, `every 2d`, `daily 9:00`, `weekly mon 9:00` and `at <datetime>`. Use runtime-local time; scans have five-minute granularity. Quiet hours such as `22:00-08:00` hold scheduled work. Set `enabled: false` to pause. Existing `trigger: manual` needs no schedule; `trigger: time` requires one. Other triggers are unsupported.

Use the consuming app's Pulses catalog and Run/Stop controls to inspect or invoke work. Disabled definitions cannot run manually. A manual Run bypasses quiet hours, does not consume the scheduled checkpoint, and cannot overlap active responsibility. Reenabling or readding a scheduled definition seeds its current slot rather than replaying missed work. Retry the same invocation with the same request ID; do not create another invocation because you are unsure whether the first was admitted.

Inspect native task and submission outcomes, not dispatch alone, to determine completion. Stop aborts the native coordinator; its abort handler cancels ordinary work and settles its passive result, including a native task-abort outcome when dispatch never happened. An interrupted external side effect may have an uncertain outcome: report that uncertainty rather than repeat it. Parent result delivery is passive context, never a follow-up that wakes the parent. Parent changes preserve old native history and the pulse's files; disabling or removing a definition does not delete either.
