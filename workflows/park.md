---
command: np:park
description: Mark a task as parked (lifecycle CRUD). Use when a task needs to be deferred without being marked skipped.
argument-hint: <task-id>
---

# /np:park

<objective>
Flip the task's frontmatter `status` field to `parked`. Like `skipped`,
parked tasks are excluded from wave-selection — but the semantic intent
is "come back to this", so `/np:unpark` returns it to `pending` rather
than implying the task was permanently dropped.
</objective>

## Execution

```bash
TASK_ID="$1"
if [ -z "$TASK_ID" ]; then
  echo "Usage: /np:park <task-id>" >&2
  exit 1
fi
node .nubos-pilot/bin/np-tools.cjs park "$TASK_ID"
```

## Scope Guardrail

**Do:** flip task status to `parked` via `lib/tasks.setTaskStatus`.
**Don't:** revert commits; modify other frontmatter fields.
## Definition of Done

Lifecycle transition. Definition of Done, per [`templates/COMPLETENESS.md`](../templates/COMPLETENESS.md):

- Rule 7 (Never leave a dangling thread) — parked task carries reason, return-condition, and timestamp.
- Rule 11 (Ship the complete thing) — STATE.md and frontmatter both updated, no split state.

Any violation = workflow exits non-zero. The orchestrator does not relax these.
