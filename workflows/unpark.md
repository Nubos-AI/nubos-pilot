---
command: np:unpark
description: Return a parked task to pending status (lifecycle CRUD). Counterpart to /np:park.
argument-hint: <task-id>
---

# /np:unpark

<objective>
Flip the task's frontmatter `status` field from `parked` back to `pending`
so it re-enters wave-selection. Note that `setTaskStatus` does not enforce
the previous status — running `/np:unpark` on any task simply sets it to
`pending`.
</objective>

## Execution

```bash
TASK_ID="$1"
if [ -z "$TASK_ID" ]; then
  echo "Usage: /np:unpark <task-id>" >&2
  exit 1
fi
node np-tools.cjs unpark "$TASK_ID"
```

## Scope Guardrail

**Do:** flip task status to `pending` via `lib/tasks.setTaskStatus`.
**Don't:** revert commits; modify other frontmatter fields.
