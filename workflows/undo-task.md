---
command: np:undo-task
description: Revert a single task commit via git revert (no history rewrite). Destructive — gated by askUser confirmation.
---

# /np:undo-task

<objective>
Revert exactly one previously committed task. The original commit stays in
the log; a new `Revert "task(<id>): …"` commit is appended. Task status is
flipped back to `pending` so the executor can pick it up again on the next
wave-loop.
</objective>

## Execution

```bash
TASK_ID="$1"
if [ -z "$TASK_ID" ]; then
  echo "Usage: /np:undo-task <task-id>" >&2
  exit 1
fi

CHOICE=$(node np-tools.cjs askuser --json '{
  "type": "select",
  "header": "Undo Task bestätigen",
  "question": "Der Task-Commit wird via git revert rückgängig gemacht (keine History-Rewrite). Fortfahren?",
  "options": [
    {"label": "Confirm", "description": "Revert ausführen — Task-Status wird auf pending zurückgesetzt."},
    {"label": "Cancel",  "description": "Nichts ändern."}
  ]
}')
case "$CHOICE" in
  Confirm*) node np-tools.cjs undo-task "$TASK_ID" ;;
  *)        echo "Aborted." ; exit 0 ;;
esac
```

## Scope Guardrail

**Do:** revert via `git revert` (forward-only); flip task status → pending.
**Don't:** rewrite history; force-push; touch other tasks.
