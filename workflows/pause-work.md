---
command: np:pause-work
description: Stamp STATE.session.stopped_at and resume_file for explicit session handoff. No git stash (D-08 semantic).
---

# /np:pause-work

<objective>
Record the session boundary in STATE.md so the next session (or a
different operator) can re-enter via `/np:resume-work`. The in-flight
checkpoint, if any, is untouched — it continues to capture the executor's
progress.
</objective>

## Execution

```bash
node .nubos-pilot/bin/np-tools.cjs init pause-work
```

Output is a small JSON payload `{ ok, stopped_at, resume_file }`. The
workflow simply displays it.

## Scope Guardrail

**Do:** stamp STATE.session; print the resume hint.
**Don't:** stash, discard, or modify the working tree; delete checkpoints
(resume-work needs them).

## Output

- STATE.md updated with `session.stopped_at = <ISO>` and
  `session.resume_file = .nubos-pilot/checkpoints/<task-id>.json` (or null
  if no active task).
