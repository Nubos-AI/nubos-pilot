---
command: np:resume-work
description: Classify session state (resume | orphan | clean) from STATE + checkpoints; re-spawn executor or prompt user for orphan handling.
---

# /np:resume-work

<objective>
Re-enter a paused session. Returns one of three states; the workflow acts
on each accordingly.
</objective>

## Initialize

```bash
INIT=$(node np-tools.cjs init resume-work)
STATUS=$(echo "$INIT" | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).status))")
```

## Execution

### status: resume

STATE.current_task matches an in-progress checkpoint. Spawn
`agents/np-executor.md` with the checkpoint payload so it continues from
`resume_hint`:

```bash
if [ "$STATUS" = "resume" ]; then
  TASK_ID=$(echo "$INIT" | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).task_id))")
  # Hand the task payload + checkpoint to agents/np-executor.md; on completion
  # the agent invokes `node np-tools.cjs commit-task "$TASK_ID"` as usual.
  echo "Resuming task $TASK_ID via agents/np-executor.md …"
fi
```

### status: orphan

Checkpoints exist but none match `STATE.current_task`:

```bash
if [ "$STATUS" = "orphan" ]; then
  CHOICE=$(node np-tools.cjs askuser --json '{
    "type": "select",
    "header": "Verwaiste Checkpoints",
    "question": "Es existieren Checkpoint-Dateien, aber STATE.current_task passt nicht. Wie vorgehen?",
    "options": [
      {"label": "Clean working tree (reset-slice)", "description": "Verwirft in-flight Änderungen und löscht den Checkpoint."},
      {"label": "Adopt orphan as current_task",      "description": "STATE wird auf den gefundenen Checkpoint gesetzt; Executor übernimmt."},
      {"label": "Abort",                              "description": "Exit, User entscheidet manuell."}
    ]
  }')
  case "$CHOICE" in
    "Abort") exit 0 ;;
  esac
fi
```

### status: clean

No active work. Print the next-step hint:

```bash
if [ "$STATUS" = "clean" ]; then
  node np-tools.cjs next
fi
```

## Scope Guardrail

**Do:** trust `init resume-work`'s classification verbatim; route each
status to its corresponding handler.
**Don't:** invent a fourth status; skip the askUser gate on orphan;
silently overwrite STATE.

## Output

- One of: executor re-spawn, user-driven orphan resolution, or next-step
  hint. STATE.md changes only via the chosen handler.
