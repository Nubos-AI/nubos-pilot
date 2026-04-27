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
LANG_DIRECTIVE=$(node .nubos-pilot/bin/np-tools.cjs lang-directive)
INIT=$(node .nubos-pilot/bin/np-tools.cjs init execute-milestone init "$PHASE")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
AGENT_SKILLS_EXECUTOR=$(node .nubos-pilot/bin/np-tools.cjs agent-skills executor 2>/dev/null)
RUNTIME=$(node .nubos-pilot/bin/np-tools.cjs detect-runtime)
WORKTREE_ISOLATION=$(node .nubos-pilot/bin/np-tools.cjs config-get workflow.worktree_isolation 2>/dev/null || echo "false")
```

**Language (SSOT = `.nubos-pilot/config.json` → `response_language`).**
`$LANG_DIRECTIVE` is authoritative for this workflow. Obey it for all user-
facing output, askuser prompts, and status updates. Pass `$LANG_DIRECTIVE`
into every np-executor spawn prompt as a system-level rule so task summaries
and checkpoint notes follow the project language. This supersedes any
directive in CLAUDE.md managed block.

Parse JSON for: `milestone`, `milestone_id`, `milestone_dir`, `waves[]` (each with `wave` (= slice number), `slice_id`, `slice_full_id`, `slice_dir`, `tasks[]`), `total_tasks`, `slice_count`, `executor_tier`, `text_mode`, `text_mode_source`, `agent_skills`.

**Askuser routing.** Every `node .nubos-pilot/bin/np-tools.cjs askuser …` block below (including the orphan-checkpoint and empty-milestone prompts) is a spec, not a literal command. Pick the path once at Initialize:
- **Claude Code** (native `AskUserQuestion` tool is available): parse the JSON spec and call `AskUserQuestion` directly. `select` → `multiSelect: false`; `multiselect` → `multiSelect: true`; `confirm` → `options: [{label: "Yes"}, {label: "No"}]`; `input` → ask free-form in chat. Use a short `header` (≤12 chars).
- **`text_mode == true`** (INIT payload): skip every askuser block and render questions as plain-text numbered lists. Opt-in via `.nubos-pilot/config.json` → `workflow.text_mode`.
- **Other runtime with TTY** (Codex, Gemini, …): execute the shell `askuser` block verbatim.

`PLAN_ID` is iterated per slice as `${milestone_id}-${slice_id}` (e.g. `M001-S001`). `TASK_ID` is iterated from each slice's `tasks[]` (e.g. `M001-S001-T0001`).

## Skills (Nubos library)

Nubos ships a skill library under `.claude/skills/np-*/` (auto-installed by `npx nubos-pilot`, present only on Claude Code). For each task in a wave, before spawning `np-executor`, classify the task by reading its `T<NNNN>-PLAN.md` and inject the matching skill triggers into the executor's spawn prompt as a "Use these skills" directive. The executor then loads each skill's `SKILL.md` via the runtime's skill mechanism and follows its rules during implementation.

Mapping (match the dominant signal in `files_modified` + task description):

| Task signal | Skills to trigger |
|---|---|
| Any UI/component edit (`.tsx`, `.jsx`, `.vue`, `.svelte`, `views/**`, `components/**`, `pages/**`, `app/**`) | `np-impeccable` (polish/audit), `np-frontend-design` (build), `np-design` (review), `np-web-design-guidelines` (a11y/UX) |
| `components.json` present in repo OR shadcn/ui imports in modified files | `np-shadcn` (in addition to UI skills above) |
| React/Next.js component or hook edit | `np-react-best-practices`, `np-composition-patterns` |
| Page/route transitions, `<ViewTransition>`, `startViewTransition` | `np-react-view-transitions` |
| React Native / Expo source (`*.tsx` under `app/`, `screens/`, `mobile/**`) | `np-react-native-skills` |
| Restyling an existing surface (no greenfield) | `np-redesign-existing-projects` |
| New surface needing visual direction | Pick exactly **one** style anchor: `np-high-end-visual-design` (default agency premium), `np-minimalist-ui`, `np-industrial-brutalist-ui`, or `np-stitch-design-taste` |
| Non-UI task (backend, infra, tooling, docs) | None — skip the skill block entirely |

**Spawn-prompt injection format.** Append to the executor prompt verbatim (one line per matched skill):

```
Use the following Nubos skills for this task: <skill-1>, <skill-2>, ...
Each skill is installed at .claude/skills/<skill>/SKILL.md and encodes a
quality bar you must satisfy before invoking commit-task.
```

If zero skills match, omit the block — do **not** invent skills. Adding new skills under `skills/np-*/` in the source repo is sufficient: the next `npx nubos-pilot update` rolls them out and you extend this mapping in one PR.

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

  # Worktree-Isolation (ADR-0008): when workflow.worktree_isolation=true,
  # create an isolated git worktree for this slice before spawning executors.
  # Executors run inside the worktree (cwd = worktree path), commits land on
  # the slice branch np/<slice-full-id>, and the slice is fast-forward merged
  # back on success. On failure: worktree stays in place for inspection.
  SLICE_CWD="$PWD"
  if [ "$WORKTREE_ISOLATION" = "true" ]; then
    WT_CREATE=$(node .nubos-pilot/bin/np-tools.cjs worktree-create "$SLICE_FULL_ID")
    SLICE_CWD=$(echo "$WT_CREATE" | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).path))")
    echo "[np:execute-phase] worktree created at $SLICE_CWD (branch np/$SLICE_FULL_ID)" >&2
  fi

  # For each task id in TASK_IDS, spawn an executor IN PARALLEL.
  # The orchestrator's parallel primitive dispatches all of them in a single
  # message (multiple Agent tool use blocks in one send).
  for TASK_ID in $TASK_IDS; do
    # IN PARALLEL:
    node .nubos-pilot/bin/np-tools.cjs checkpoint start "$TASK_ID" --phase "$PHASE" --plan "$SLICE_FULL_ID" --wave "$((WAVE_INDEX+1))"

    TASK_JSON=$(node .nubos-pilot/bin/np-tools.cjs init execute-milestone execute-task "$PHASE" "$TASK_ID")
    if [[ "$TASK_JSON" == @file:* ]]; then TASK_JSON=$(cat "${TASK_JSON#@file:}"); fi

    EXECUTOR_START=$(node .nubos-pilot/bin/np-tools.cjs metrics start-timestamp)
    EXECUTOR_MODEL=$(node .nubos-pilot/bin/np-tools.cjs resolve-model np-executor --profile frontier)

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
      if [ "$WORKTREE_ISOLATION" = "true" ]; then
        echo "  Worktree $SLICE_CWD left in place for inspection. Clean up with: /np:reset-slice $TASK_ID" >&2
      fi
      exit "$COMMIT_STATUS"
    fi
  done
  # wait for all parallel executors in this wave to finish before next wave

  # After every task in the slice committed: aggregate per-task summaries into
  # the slice-level S<NNN>-SUMMARY.md so /np:validate-phase can audit it.
  SLICE_NUM=$(echo "$WAVE" | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).wave))")
  node .nubos-pilot/bin/np-tools.cjs init execute-milestone finalize-slice "$PHASE" "$SLICE_NUM" >/dev/null

  # Worktree merge-back (ADR-0008 D-8.7): fast-forward-only merge the slice
  # branch back onto the invoking workspace's current branch. Non-FF (e.g.
  # because the base branch advanced during execution) fails hard — that
  # surfaces the drift to the user rather than silently rewriting task SHAs.
  if [ "$WORKTREE_ISOLATION" = "true" ]; then
    FF_RESULT=$(node .nubos-pilot/bin/np-tools.cjs worktree-ff-merge "$SLICE_FULL_ID" 2>&1)
    FF_STATUS=$?
    if [ "$FF_STATUS" -ne 0 ]; then
      echo "[np:execute-phase] ff-merge for $SLICE_FULL_ID failed — worktree left in place for inspection:" >&2
      echo "  $FF_RESULT" >&2
      echo "  To resolve: cd into $SLICE_CWD, rebase onto current base, then re-run this workflow." >&2
      exit "$FF_STATUS"
    fi
    node .nubos-pilot/bin/np-tools.cjs worktree-remove "$SLICE_FULL_ID" >/dev/null
    echo "[np:execute-phase] worktree $SLICE_FULL_ID merged + removed." >&2
  fi
done

# Milestone done — regenerate every slice summary so retroactive / resumed
# runs also end with a complete audit surface.
node .nubos-pilot/bin/np-tools.cjs init execute-milestone finalize-milestone "$PHASE" >/dev/null
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
