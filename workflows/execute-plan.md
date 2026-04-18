---
command: np:execute-plan
description: Execute all tasks in a single plan (wave-ordered, atomic-commit-per-task). Sub-case of /np:execute-phase scoped to one plan.
---

# /np:execute-plan

<objective>
Same semantics as `/np:execute-phase` but scoped to one plan — useful when
re-running or revising a single plan after its peers have already shipped.
</objective>

## Initialize

```bash
PLAN_ID="$1"   # e.g. 06-01
INIT=$(node np-tools.cjs init execute-plan "$PLAN_ID")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
AGENT_SKILLS_EXECUTOR=$(node np-tools.cjs agent-skills executor 2>/dev/null)
```

Parse: `plan_id`, `phase`, `padded`, `plan_path`, `tasks_dir`, `waves`,
`task_count`, `executor_tier`, `agent_skills`.

## Pre-Flight — orphan-checkpoint guard

```bash
RESUME=$(node np-tools.cjs init resume-work)
RESUME_STATUS=$(echo "$RESUME" | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).status))")
if [ "$RESUME_STATUS" = "orphan" ]; then
  CHOICE=$(node np-tools.cjs askuser --json '{
    "type": "select",
    "header": "Verwaiste Checkpoints gefunden",
    "question": "Checkpoints ohne passenden STATE.current_task gefunden — weitermachen?",
    "options": [
      {"label": "Clean and proceed", "description": "reset-slice + fresh start."},
      {"label": "Abort",              "description": "Exit, User entscheidet manuell."}
    ]
  }')
  case "$CHOICE" in
    "Abort") exit 0 ;;
  esac
fi
```

## Execution — per wave, per task

For each wave in `waves`, for each `TASK_ID`:

```bash
TASK_ID="06-01-T01"
node np-tools.cjs checkpoint start "$TASK_ID" --phase "$phase" --plan "$PLAN_ID" --wave 1

TASK_JSON=$(node np-tools.cjs init execute-phase execute-task "$phase" "$TASK_ID")
if [[ "$TASK_JSON" == @file:* ]]; then TASK_JSON=$(cat "${TASK_JSON#@file:}"); fi
```

Spawn `agents/np-executor.md` (sonnet) per task with `files_modified`,
`<files_to_read>` = [plan_path, task_file, prior SUMMARY.md files].
Executor performs the work, runs the `<verify>` command, then:

```bash
node np-tools.cjs checkpoint transition "$TASK_ID" verifying
node np-tools.cjs checkpoint transition "$TASK_ID" pre-commit
node np-tools.cjs commit-task "$TASK_ID"
COMMIT_STATUS=$?
if [ "$COMMIT_STATUS" -ne 0 ]; then
  echo "[np:execute-plan] commit-task failed for $TASK_ID" >&2
  exit "$COMMIT_STATUS"
fi
```

## Scope Guardrail

**Do:** one commit per task via `commit-task`; one executor per task.
**Don't:** bundle tasks, call bare `git`, or span multiple plans.

## Output

- N commits (N = count of tasks in the plan), each
  `task(<plan_id>-T<NN>): <name>`.
- Plan ready for `/np:verify-work` (phase-scoped).
