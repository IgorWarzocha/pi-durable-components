// Adapted from pi-pulses/skills/pulses/SKILL.md at 12c4357b2c401fe9be8c6c82d2ae252c0f986937.
// Copyright (c) 2026 Igor Warzocha. MIT. See NOTICE and LICENSE.
export const pulseAuthoring = `Create pulses/<self-explanatory-name>/PULSE.md in the workspace shown by pulses({}). Use a lowercase kebab-case folder name. Preserve its AGENTS.md, existing journals and artifacts. Read applicable workspace and pulse-local instructions. Native cwd remains the workspace root; use the explicit pulse-home path for local files.

Example PULSE.md:
---
title: Check agreed sources
schedule: every 5h
enabled: true
quietHours: 22:00-08:00
---
Check the agreed sources for changes since the previous run.
Post actionable findings to the designated available destination.

title and schedule are required. Schedules: manual, every 30m, every 5h, every 2d, daily 09:00, weekly fri 17:00 or at <datetime>. Use an explicit timezone offset for a one-time timestamp when timezone matters. Daily and weekly times and quietHours use the runtime's local timezone. Checks run every five minutes. Existing trigger: manual needs no schedule; trigger: time requires one.

enabled defaults to true. Set false to pause both scheduled and manual runs. quietHours is optional and accepts HH:MM-HH:MM, including overnight ranges. Manual runs bypass quiet hours without consuming recurrence checkpoints. Optional expiresAt stops new admissions at that datetime. Child execution is the default; target: resident requires an explicit host-supplied continuing resident. Leave unrelated frontmatter keys, comments and body conventions untouched.

Keep the body a short SOP: the actual task, sources, destination and consequential limits. Do not duplicate general skill guidance or require skills the task does not need. Define concrete destinations only when available. The worker receives the body plus standard result-routing and procedural-feedback instructions; do not repeat them in definitions.

Use ordinary file tools to edit definitions. Disable routines worth keeping for later; delete obsolete definitions without deleting their journals or artifacts. There is no authoring configuration API. pulses({}) lists paths and invalid-definition diagnostics. pulses({run: "name"}) requests an immediate run. Admission is not completion. Inspect native task and submission outcomes through the consuming app. Child results are passive context and never wake the parent; resident work reports in that conversation.

Tracked missed occurrences coalesce into one run per job with a count and period. Cover that period rather than replaying each occurrence. Host restrictions, concurrency and active responsibility can hold admission. Reenabling or readding seeds the current slot, not disabled history. Removed, expired or superseded pending work stays inspectable. Retrying the same native tool task rejoins its accepted request, even after definition edits or deletion. An interrupted external side effect may have an uncertain outcome; report that uncertainty rather than repeat it. Stop uses the consuming app's native controls. It aborts only the coordinator and its owned input, then settles its passive report. Removing a definition or component never deletes files or native history.`;
