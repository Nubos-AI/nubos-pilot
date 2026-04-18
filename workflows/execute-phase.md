---
command: np:execute-phase
description: Wave-based phase execution. Spawns executor (sonnet) per task with atomic-commit-per-unit enforced via np-tools.cjs commit-task helper (D-03/D-25).
---

# /np:execute-phase

<objective>
Run every wave of every plan in a given phase: for each task in wave-order,
start a checkpoint, spawn agents/np-executor.md (sonnet), verify, and invoke
`node np-tools.cjs commit-task <task-id>` for the atomic commit. All git
operations route through lib/git.cjs — agents NEVER call `git` directly
(ADR-0004, CLAUDE.md §Git operations).
</objective>

## Initialize

```bash
PHASE="$1"
INIT=$(node np-tools.cjs init execute-phase "$PHASE")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
AGENT_SKILLS_EXECUTOR=$(node np-tools.cjs agent-skills executor 2>/dev/null)
RUNTIME=$(node -e "console.log(require('./lib/runtime/index.cjs').detect().runtime)")
```

Parse JSON for: `phase`, `padded`, `phase_dir`, `plans[]` (each with
`plan_path`, `waves`, `task_count`), `executor_tier`, `agent_skills`.

`PLAN_ID` is iterated from `plans[]` (e.g. `06-01`) and `TASK_ID` is iterated
from each plan's `waves[]` entries. Both are used by the metrics-record calls
in the per-task loop below.

## Pre-Flight — orphan-checkpoint guard

Detect stale checkpoints from a prior run before starting new work:

```bash
RESUME=$(node np-tools.cjs init resume-work)
RESUME_STATUS=$(echo "$RESUME" | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).status))")
if [ "$RESUME_STATUS" = "orphan" ]; then
  CHOICE=$(node np-tools.cjs askuser --json '{
    "type": "select",
    "header": "Verwaiste Checkpoints gefunden",
    "question": "Vor dem Phase-Start wurden Checkpoint-Dateien ohne passenden STATE.current_task gefunden. Was tun?",
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

## Execution — per wave, per task

For each plan in `plans[]`, for each wave in `plan.waves`, for each task-id
in the wave:

```bash
TASK_ID="06-01-T01"   # example — iterated from waves[]
PLAN_ID="06-01"       # example — iterated from plans[]

# Start crash-safety checkpoint.
node np-tools.cjs checkpoint start "$TASK_ID" --phase "$PHASE" --plan "$PLAN_ID" --wave 1

# Fetch the executor-spawn payload (files_modified + task_name + tier).
TASK_JSON=$(node np-tools.cjs init execute-phase execute-task "$PHASE" "$TASK_ID")
if [[ "$TASK_JSON" == @file:* ]]; then TASK_JSON=$(cat "${TASK_JSON#@file:}"); fi

# --- Resolve executor model + start metrics clock (D-06) ---
EXECUTOR_START=$(node np-tools.cjs metrics start-timestamp)
EXECUTOR_MODEL=$(node np-tools.cjs resolve-model executor --profile balanced)
```

Spawn `agents/np-executor.md` (tier: sonnet, from `executor_tier`, model
resolved as `$EXECUTOR_MODEL`) with a `<files_to_read>` block containing: the
plan file, the task file, prior phase SUMMARY.md files. The host runtime
consumes `$EXECUTOR_MODEL` via its spawn adapter (empty string → omit the
`model:` parameter per Phase 8 D-22 inherit-pattern). The executor edits
EXACTLY the paths in `files_modified` (D-04 — no scope expansion), runs any
`<verify>` commands, then invokes the commit helper:

```bash
node np-tools.cjs checkpoint transition "$TASK_ID" verifying
node np-tools.cjs checkpoint transition "$TASK_ID" pre-commit

# Atomic commit — LOUD FAIL propagates if every files_modified entry is
# gitignored (D-25). The helper prints a JSON payload `{ok, task_id, sha, files}`.
node np-tools.cjs commit-task "$TASK_ID"
COMMIT_STATUS=$?

# --- Close metrics record for this executor task (D-06/D-08) ---
EXECUTOR_END=$(node np-tools.cjs metrics end-timestamp)
EXECUTOR_STATUS=ok
[ "$COMMIT_STATUS" -ne 0 ] && EXECUTOR_STATUS=error
node np-tools.cjs metrics record \
  --agent np-executor --tier sonnet --resolved-model "$EXECUTOR_MODEL" \
  --phase "$PHASE" --plan "$PLAN_ID" --task "$TASK_ID" \
  --started "$EXECUTOR_START" --ended "$EXECUTOR_END" \
  --tokens-in "${TOKENS_IN:-0}" --tokens-out "${TOKENS_OUT:-0}" \
  --retry-count "${RETRY_COUNT:-0}" --status "$EXECUTOR_STATUS" --runtime "$RUNTIME"

if [ "$COMMIT_STATUS" -ne 0 ]; then
  echo "[np:execute-phase] commit-task failed for $TASK_ID — aborting wave." >&2
  exit "$COMMIT_STATUS"
fi
```

After a full phase completes: point the operator at `/np:verify-work
$PHASE`.

## Scope Guardrail

<!-- scope_guardrail -->
**Do:**
- Start one checkpoint per task before spawning the executor agent.
- Spawn `agents/np-executor.md` (sonnet) once per task with only the task's
  `files_modified` in scope.
- Route every commit through `node np-tools.cjs commit-task` so
  `assertCommittablePaths` (D-25) runs.
- Hard-stop the wave when `commit-task` returns a non-zero exit (D-23
  propagation — don't mask the failure).

**Don't:**
- Invoke `git commit`, `git add`, or any bare git command from this
  workflow or the spawned agent (CLAUDE.md §Git operations).
- Bundle two tasks into one commit (ADR-0004 atomicity).
- Skip the checkpoint start step — it's the crash-safety primitive
  `resume-work` depends on.
- Pass `--no-verify` or `--force` anywhere in the pipeline.
<!-- /scope_guardrail -->

## Output

- One git commit per completed task (`task(<phase>-<plan>-T<NN>): <name>`).
- Per-task checkpoint lifetime: `start` → (`transition verifying|pre-commit`)+
  → `deleteCheckpoint` (inside commit-task on success).
- STATE.md updated via `startTask`'s coordinated lock-cycle (D-08).
- Verified work surface for `/np:verify-work $PHASE`.
