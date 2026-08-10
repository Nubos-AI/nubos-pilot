---
command: np:skip
description: Mark a task as skipped (lifecycle CRUD). The task is excluded from wave-selection until it is unparked or its status is set back to pending.
argument-hint: <task-id>
---

# /np:skip

<objective>
Flip the task's frontmatter `status` field to `skipped`. The wave-selector
treats `skipped` like `done` for advancement purposes, so the next wave
can proceed without this task. No commit is made; the task file is rewritten
in place.
</objective>

## Execution

```bash
TASK_ID="$1"
if [ -z "$TASK_ID" ]; then
  echo "Usage: /np:skip <task-id>" >&2
  exit 1
fi
node .nubos-pilot/bin/np-tools.cjs skip "$TASK_ID"
```

## Scope Guardrail

**Do:** flip task status to `skipped` via `lib/tasks.setTaskStatus`.
**Don't:** revert commits; modify other frontmatter fields.
## Definition of Done

Lifecycle transition. Definition of Done, per [`templates/COMPLETENESS.md`](../templates/COMPLETENESS.md):

- Rule 7 (Never leave a dangling thread) — skipped task carries reason and timestamp; STATE.md and frontmatter are updated atomically.
- Rule 11 (Ship the complete thing) — verifier sees the skip-marker; no silent disappearance.

Any violation = workflow exits non-zero. The orchestrator does not relax these.
