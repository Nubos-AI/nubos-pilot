---
command: np:execute-phase
description: Executes a milestone wave-by-wave (slice = wave). Tasks inside a slice run in parallel; slices run serially. One executor agent per task, atomic commit per task via np-tools.cjs commit-task.
argument-hint: <milestone-number>
---

# /np:execute-phase

<objective>
Execute every slice of a milestone in wave order: slice S001 first (all its tasks in parallel), then S002, etc. Per task: start a checkpoint, spawn `agents/np-executor.md` (sonnet), verify, and invoke `node .nubos-pilot/bin/np-tools.cjs commit-task <task-full-id>` for the atomic commit. All git operations route through lib/git.cjs — agents NEVER call `git` directly (ADR-0004, CLAUDE.md §Git operations).

**Wave semantics:** one slice == one wave. Tasks in a slice have no intra-slice deps (they're parallel-safe by planner contract). Cross-slice deps flow forward only: a task in S002 may depend on a task in S001.
</objective>

## Initialize

```bash
PHASE="$1"
INIT=$(node .nubos-pilot/bin/np-tools.cjs init execute-milestone "$PHASE")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
AGENT_SKILLS_EXECUTOR=$(node .nubos-pilot/bin/np-tools.cjs agent-skills executor 2>/dev/null)
RUNTIME=$(node -e "console.log(require('./lib/runtime/index.cjs').detect().runtime)")
```

Parse JSON for: `milestone`, `milestone_id`, `milestone_dir`, `waves[]` (each with `wave` (= slice number), `slice_id`, `slice_full_id`, `slice_dir`, `tasks[]`), `total_tasks`, `slice_count`, `executor_tier`, `agent_skills`.

`PLAN_ID` is iterated per slice as `${milestone_id}-${slice_id}` (e.g. `M001-S001`). `TASK_ID` is iterated from each slice's `tasks[]` (e.g. `M001-S001-T0001`).

## Pre-Flight — orphan-checkpoint guard

Detect stale checkpoints from a prior run before starting new work:

```bash
RESUME=$(node .nubos-pilot/bin/np-tools.cjs init resume-work)
RESUME_STATUS=$(echo "$RESUME" | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).status))")
if [ "$RESUME_STATUS" = "orphan" ]; then
  CHOICE=$(node .nubos-pilot/bin/np-tools.cjs askuser --json '{
    "type": "select",
    "header": "Verwaiste Checkpoints gefunden",
    "question": "Vor dem Milestone-Start wurden Checkpoint-Dateien ohne passenden STATE.current_task gefunden. Was tun?",
    "options": [
      {"label": "Clean working tree (reset-slice)", "description": "Verwirft die in-flight Task und löscht ihren Checkpoint."},
      {"label": "Resume the orphan task",            "description": "Setzt STATE.current_task auf den Checkpoint-Eintrag und spawnt den Executor."},
      {"label": "Abort",                              "description": "Exit, User entscheidet manuell."}
    ]
  }')
  case "$CHOICE" in
    "Abort") exit 0 ;;
  esac
fi
```

## Pre-Flight — empty milestone guard

```bash
TOTAL_TASKS=$(echo "$INIT" | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).total_tasks))")
if [ "$TOTAL_TASKS" = "0" ]; then
  echo "execute-phase: milestone $PHASE has 0 tasks. Did /np:plan-phase $PHASE run with task files scaffolded?" >&2
  echo "  Try: /np:plan-phase $PHASE --repromote" >&2
  exit 1
fi
```

## Execution — slices serial, tasks parallel within a slice

For each wave (slice) in `waves[]`, in order:

1. Dispatch **all tasks in the slice in parallel** (one executor agent per task).
2. Wait until every task in the slice is committed OR one failed.
3. If any task failed → stop the wave and exit non-zero. Previous committed tasks remain committed.
4. Move to the next slice.

```bash
# Pseudocode for the per-wave loop. The orchestrator uses its parallel-spawn
# primitive; this pseudocode shows the shape but not the concrete agent syntax.
for WAVE_INDEX in 0 1 2 ...; do
  WAVE=$(echo "$INIT" | node -e "process.stdin.on('data', d => console.log(JSON.stringify(JSON.parse(d).waves[$WAVE_INDEX])))")
  [ -z "$WAVE" ] || [ "$WAVE" = "undefined" ] && break

  SLICE_FULL_ID=$(echo "$WAVE" | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).slice_full_id))")
  TASK_IDS=$(echo "$WAVE" | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).tasks.map(t=>t.id).join(' ')))")

  echo "=== Wave $((WAVE_INDEX+1)): $SLICE_FULL_ID — tasks: $TASK_IDS ===" >&2

  # For each task id in TASK_IDS, spawn an executor IN PARALLEL.
  # The orchestrator's parallel primitive dispatches all of them in a single
  # message (multiple Agent tool use blocks in one send).
  for TASK_ID in $TASK_IDS; do
    # IN PARALLEL:
    node .nubos-pilot/bin/np-tools.cjs checkpoint start "$TASK_ID" --phase "$PHASE" --plan "$SLICE_FULL_ID" --wave "$((WAVE_INDEX+1))"

    TASK_JSON=$(node .nubos-pilot/bin/np-tools.cjs init execute-milestone execute-task "$PHASE" "$TASK_ID")
    if [[ "$TASK_JSON" == @file:* ]]; then TASK_JSON=$(cat "${TASK_JSON#@file:}"); fi

    EXECUTOR_START=$(node .nubos-pilot/bin/np-tools.cjs metrics start-timestamp)
    EXECUTOR_MODEL=$(node .nubos-pilot/bin/np-tools.cjs resolve-model executor --profile frontier)

    # Spawn agents/np-executor.md (tier: sonnet, model resolved as $EXECUTOR_MODEL)
    # with a <files_to_read> block containing: the task plan file, the slice
    # plan file, prior slice SUMMARY files, milestone CONTEXT.md.
    # Executor edits EXACTLY the paths in files_modified (D-04 — no scope
    # expansion), runs <verify> commands, then invokes commit-task:

    node .nubos-pilot/bin/np-tools.cjs checkpoint transition "$TASK_ID" verifying
    node .nubos-pilot/bin/np-tools.cjs checkpoint transition "$TASK_ID" pre-commit
    node .nubos-pilot/bin/np-tools.cjs commit-task "$TASK_ID"
    COMMIT_STATUS=$?

    EXECUTOR_END=$(node .nubos-pilot/bin/np-tools.cjs metrics end-timestamp)
    EXECUTOR_STATUS=ok
    [ "$COMMIT_STATUS" -ne 0 ] && EXECUTOR_STATUS=error
    node .nubos-pilot/bin/np-tools.cjs metrics record \
      --agent np-executor --tier sonnet --resolved-model "$EXECUTOR_MODEL" \
      --phase "$PHASE" --plan "$SLICE_FULL_ID" --task "$TASK_ID" \
      --started "$EXECUTOR_START" --ended "$EXECUTOR_END" \
      --tokens-in "${TOKENS_IN:-0}" --tokens-out "${TOKENS_OUT:-0}" \
      --retry-count "${RETRY_COUNT:-0}" --status "$EXECUTOR_STATUS" --runtime "$RUNTIME"

    if [ "$COMMIT_STATUS" -ne 0 ]; then
      echo "[np:execute-phase] commit-task failed for $TASK_ID — aborting wave $SLICE_FULL_ID." >&2
      exit "$COMMIT_STATUS"
    fi
  done
  # wait for all parallel executors in this wave to finish before next wave
done
```

After every slice completes, point the operator at `/np:validate-phase $PHASE` to run the UAT per slice.

## Scope Guardrail

<!-- scope_guardrail -->
**Do:**
- Dispatch all tasks in a slice **in parallel** (one executor per task).
- Move to next slice **only after** every task in the current slice is committed.
- Start one checkpoint per task before spawning the executor agent.
- Spawn `agents/np-executor.md` once per task with only that task's `files_modified` in scope.
- Route every commit through `node .nubos-pilot/bin/np-tools.cjs commit-task` so `assertCommittablePaths` (D-25) runs.
- Hard-stop the wave when `commit-task` returns a non-zero exit.

**Don't:**
- Run tasks across slices in parallel — slices are serial.
- Run intra-slice tasks serially — they're parallel by planner contract.
- Invoke `git commit`, `git add`, or any bare git command from this workflow or the spawned agent (CLAUDE.md §Git operations).
- Bundle two tasks into one commit (ADR-0004 atomicity).
- Skip the checkpoint start step — it's the crash-safety primitive `resume-work` depends on.
- Pass `--no-verify` or `--force` anywhere in the pipeline.
<!-- /scope_guardrail -->

## Output

- One git commit per completed task (`task(<milestone-id>-<slice-id>-T<NNNN>): <name>`).
- Per-task checkpoint lifetime: `start` → (`transition verifying|pre-commit`)+ → `deleteCheckpoint` (inside commit-task on success).
- STATE.md updated via `startTask`'s coordinated lock-cycle (D-08).
- Per slice: updated `S<NNN>-SUMMARY.md` aggregated from task summaries (triggered by the executor agent after the last task in a wave).
- Verified work surface for `/np:validate-phase $PHASE`.
