---
name: pulses-ops
description: Manage folder-owned pulses and inspect native scheduled work.
---

# Pulses

Keep each pulse in `pulses/<id>/PULSE.md`, using a kebab-case directory name. Preserve its `AGENTS.md`, existing `runs/` journals and other artifacts. Read applicable workspace and pulse-local instructions before working. Native cwd remains the workspace root; use the explicit pulse-home path for local files. Do not invent an app-managed output directory or universal journal schema.

Frontmatter accepts `title`, `schedule`, `enabled`, optional `quietHours`, `expiresAt` and `target`. Leave unrelated keys, comments and body conventions alone. Schedules are `manual`, `every 30m`, `every 3h`, `every 2d`, `daily 9:00`, `weekly mon 9:00` and `at <datetime>`. Use runtime-local time. Scans have five-minute granularity. Quiet hours such as `22:00-08:00` hold scheduled work. `expiresAt` takes a datetime. Child execution is the default. Use `target: resident` only when the host supplies the intended continuing resident. Existing `trigger: manual` needs no schedule and `trigger: time` requires one.

Use `pulses({})` to list paths and invalid definitions, `pulses({run:"name"})` to request a run and `pulses({skill:true})` for authoring guidance. The consuming app's native controls expose execution outcomes and Stop. Disabled definitions cannot run manually. A manual Run bypasses quiet hours, does not consume the scheduled checkpoint, and cannot overlap active responsibility. Host restrictions can hold admission. On resume, tracked missed occurrences coalesce into one run per job with an explicit count and period. Respect that period rather than repeating each occurrence. Different jobs share a configurable execution limit, initially two. Reenabling or readding a disabled definition seeds its current slot rather than recovering disabled history. Removed, expired and superseded pending work stays inspectable. Retry an invocation with the same request ID when its admission is uncertain.

Inspect native task and submission outcomes, not dispatch alone, to determine completion. Stop aborts the native coordinator and the run owning its input, then settles its passive result. An interrupted external side effect may have an uncertain outcome. Report that uncertainty rather than repeat it. Child result delivery is passive context, never a follow-up that wakes the parent. Resident-target work reports in that resident's ordinary conversation. Parent changes preserve old native history and the pulse's files. Disabling or removing a definition deletes neither.
