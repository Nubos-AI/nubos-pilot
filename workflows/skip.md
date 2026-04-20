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
node np-tools.cjs skip "$TASK_ID"
```

## Scope Guardrail

**Do:** flip task status to `skipped` via `lib/tasks.setTaskStatus`.
**Don't:** revert commits; modify other frontmatter fields.
