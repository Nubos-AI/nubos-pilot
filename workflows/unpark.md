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
node .nubos-pilot/bin/np-tools.cjs unpark "$TASK_ID"
```

## Scope Guardrail

**Do:** flip task status to `pending` via `lib/tasks.setTaskStatus`.
**Don't:** revert commits; modify other frontmatter fields.
## Definition of Done

Lifecycle transition. Definition of Done, per [`templates/COMPLETENESS.md`](../templates/COMPLETENESS.md):

- Rule 7 (Never leave a dangling thread) — return-condition recorded; STATE.md and frontmatter updated atomically.
- Rule 11 (Ship the complete thing) — task is re-executable on exit.

Any violation = workflow exits non-zero. The orchestrator does not relax these.
