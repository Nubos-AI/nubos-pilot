---
command: np:reset-slice
description: Restore working-tree files of the in-flight task and clear current_task. Cheap, working-tree-only — no commit history change.
---

# /np:reset-slice

<objective>
Discard the unsaved work of the currently in-flight task: `git restore`
each file in the checkpoint's `files_touched`, delete the checkpoint,
clear `STATE.current_task`, flip task status back to `pending`. No commit
is made and no history is rewritten — this is the cheapest possible undo
of a task that is mid-execution.
</objective>

## Execution

```bash
CHOICE=$(node np-tools.cjs askuser --json '{
  "type": "select",
  "header": "Reset slice bestätigen",
  "question": "Working-Tree-Änderungen des aktuellen Tasks (gemäß checkpoint.files_touched) werden via git restore zurückgesetzt. Fortfahren?",
  "options": [
    {"label": "Confirm", "description": "Working-Tree zurücksetzen, checkpoint löschen, Task-Status pending."},
    {"label": "Cancel",  "description": "Nichts ändern."}
  ]
}')
case "$CHOICE" in
  Confirm*) node np-tools.cjs reset-slice ;;
  *)        echo "Aborted." ; exit 0 ;;
esac
```

## Scope Guardrail

**Do:** `git restore` files_touched; delete checkpoint; clear
`STATE.current_task`; flip task status → pending.
**Don't:** revert commits (use `/np:undo-task`); touch files outside
files_touched (T-06-19 accepted).
