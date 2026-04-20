---
command: np:plan-phase
description: Creates PLAN.md for a phase with a 2-iteration planner ↔ plan-checker verification loop.
argument-hint: <phase-number> [--research]
---

# np:plan-phase

Minimum Phase-5 scope: spawn `agents/np-planner.md` (opus) to write PLAN.md,
spawn `agents/np-plan-checker.md` (opus) to verify, iterate at most twice
(D-15), then either commit or escalate via `askuser` gate (D-17). All
state — including the verification audit trail — lives in append-only
`{phase_dir}/{padded}-PLAN-REVIEW.md` (D-16).

**Scope note (Phase 5):** No advisor subagent, no `--chain` auto-advance, no
multi-plan batching. One phase → one run → one PLAN.md (± `tasks/` when
promotion triggers fire per Plan 05-04).

## Initialize

### Parse Arguments

Positional: `<phase-number>`. Flags: `--research` (auto-run `/np:research-phase`
when RESEARCH.md is missing, instead of prompting via Gate 2).

```bash
PHASE=""
RESEARCH_FLAG=0
for arg in "$@"; do
  case "$arg" in
    --research) RESEARCH_FLAG=1 ;;
    --*)        echo "Unknown flag: $arg" >&2; exit 2 ;;
    *)          [[ -z "$PHASE" ]] && PHASE="$arg" ;;
  esac
done
if [[ -z "$PHASE" ]]; then
  echo "Usage: /np:plan-phase <phase-number> [--research]" >&2
  exit 2
fi
```

```bash
INIT=$(node np-tools.cjs init plan-phase init "$PHASE")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
AGENT_SKILLS_PLANNER=$(node np-tools.cjs agent-skills planner 2>/dev/null)
AGENT_SKILLS_CHECKER=$(node np-tools.cjs agent-skills plan-checker 2>/dev/null)
RUNTIME=$(node -e "console.log(require('./lib/runtime/index.cjs').detect().runtime)")
```

Parse JSON for: `phase`, `padded`, `phase_dir`, `phase_name`, `goal`,
`requirements`, `success_criteria`, `has_context`, `has_research`, `has_plan`,
`context_path`, `research_path`, `plan_review_path`, `planner_tier`,
`checker_tier`, `agent_skills`.

`PLAN_ID` and `TASK_ID` default to `${padded}-01` / `${padded}-plan` for the
metrics records below; the planner loop itself is the single Plan 01 task from
the runtime's point of view.

```bash
PLAN_ID="${padded}-01"
TASK_ID="${padded}-plan"
```

## Pre-Flight Guards

<pre_flight>
Three independent gates. Each uses `np-tools.cjs askuser` (never a bare
host-specific prompt tool — executor-host portability invariant per Phase 3 SC-5).

### Gate 1 — Missing CONTEXT.md

If `has_context == false`:

```bash
CHOICE=$(node np-tools.cjs askuser --json '{
  "type": "select",
  "header": "Missing CONTEXT.md",
  "question": "CONTEXT.md is not present for this phase. Continue?",
  "options": [
    {"label": "Run /np:discuss-phase first", "description": "Recommended — capture user decisions before planning."},
    {"label": "Continue without CONTEXT.md", "description": "Not recommended — planner will work from roadmap goal alone."},
    {"label": "Abort",                       "description": "Exit without changes."}
  ]
}')
case "$CHOICE" in
  "Run /np:discuss-phase"*) echo "Run: /np:discuss-phase $PHASE"; exit 0 ;;
  "Abort")                  exit 0 ;;
esac
```

### Gate 2 — Missing RESEARCH.md

If `has_research == false` AND workflow config requires it.

**When `--research` flag is set:** skip the interactive prompt. The
orchestrator MUST first dispatch `/np:research-phase $PHASE`, wait for it to
commit RESEARCH.md, then re-run the **Initialize** block above to refresh
`has_research` before continuing. No Gate 2 question is shown.

```bash
if [[ "$has_research" == "false" && "$RESEARCH_FLAG" == "1" ]]; then
  echo "research-auto: dispatching /np:research-phase $PHASE before planning" >&2
  exit 42
fi
```

Otherwise (flag not set), prompt the user:

```bash
CHOICE=$(node np-tools.cjs askuser --json '{
  "type": "select",
  "header": "Missing RESEARCH.md",
  "question": "RESEARCH.md is not present for this phase. Continue?",
  "options": [
    {"label": "Run /np:research-phase first", "description": "Recommended — stack + pitfalls guide planning."},
    {"label": "Skip research",                "description": "Planner proceeds with CONTEXT-only context."},
    {"label": "Abort",                        "description": "Exit without changes."}
  ]
}')
case "$CHOICE" in
  "Run /np:research-phase"*) echo "Run: /np:research-phase $PHASE"; exit 0 ;;
  "Abort")                   exit 0 ;;
esac
```

**Exit code 42 contract:** when the orchestrator sees exit 42, it MUST run
`/np:research-phase $PHASE` and then re-enter `/np:plan-phase $PHASE`
(without the `--research` flag — `has_research` will now be `true`).

### Gate 3 — PLAN.md already exists

If `has_plan == true`:

```bash
CHOICE=$(node np-tools.cjs askuser --json '{
  "type": "select",
  "header": "PLAN.md already exists",
  "question": "A PLAN.md is already present for this phase. Overwrite?",
  "options": [
    {"label": "Overwrite", "description": "Back up current PLAN.md to PLAN.md.archive.md and replan."},
    {"label": "Abort",     "description": "Exit without changes."}
  ]
}')
case "$CHOICE" in
  "Abort") exit 0 ;;
  "Overwrite")
    for p in "$phase_dir"/*-PLAN.md; do
      [ -f "$p" ] && mv "$p" "$p.archive.md"
    done
    ;;
esac
```
</pre_flight>

## Downstream Awareness

<!-- downstream_awareness -->
**PLAN.md feeds into:**

1. **plan-checker** — Goal-backward verification. Every task must trace back
   to one or more requirements from the roadmap, and every success criterion
   must have at least one covering task.
2. **executor** (`/np:execute-phase`) — Reads PLAN.md as a prompt, not a doc.
   Tasks must be atomic (one test, one implementation, one commit each).
3. **verifier** (Phase 10) — Re-runs goal-backward checks against executed
   artifacts. Same taxonomy as plan-checker.

**PLAN-REVIEW.md feeds into:**

- The user (audit trail on every iteration, preserved across abort/restart).
- Phase 6 `np:undo` (reads PLAN-REVIEW.md to detect mid-iteration state).
- Phase 10 review commands (verdict history for regression analysis).
<!-- /downstream_awareness -->

## Philosophy

<!-- philosophy -->
A plan is a **prompt**, not a document. If the executor has to re-interpret
the plan, it will drift from what the user asked for. The plan-checker is an
**adversarial reader** — it assumes the planner missed something and tries to
find it before the executor burns context discovering the gap.

Two iterations is the hard ceiling (D-15). If the planner cannot satisfy the
checker in 2 rounds, the loop is pathological — either the context is
unclear or the goal is ambiguous. The 3-option escalation gate hands control
back to the user rather than spinning indefinitely.

**Append-only audit trail (D-16):** PLAN-REVIEW.md is never truncated, even
on abort. Every iteration adds a dated section. This lets the user (and
future agents) replay exactly what the planner produced and what the checker
flagged, commit-by-commit.
<!-- /philosophy -->

## Scope Guardrail

<!-- scope_guardrail -->
**Do:**
- Spawn planner → plan-checker in strict sequence.
- Append every verdict to PLAN-REVIEW.md before deciding pass/fail.
- Commit PLAN.md only after a `passed` verdict OR an explicit
  "commit-with-warnings" user choice on the iter-2 gate.
- Scaffold `tasks/` directory ONLY when `plan-phase-promote-check` returns
  `promote: true`. No override flag (D-20).

**Don't:**
- Run a third planner iteration. The loop is fixed at 2 rounds.
- Modify PLAN-REVIEW.md except via `np-tools.cjs init plan-phase plan-review-append`.
- Delete PLAN-REVIEW.md on abort (D-17).
- Promote to `tasks/` based on planner judgement — deterministic triggers only.
- Invoke host-specific prompt tools directly. Always `np-tools.cjs askuser --json …`.
<!-- /scope_guardrail -->

## Verification Loop

The loop runs at most twice. Each iteration: spawn planner → spawn plan-checker
→ append verdict → decide.

```bash
LAST_FINDINGS=""
for ITER in 1 2; do
  MODE="initial"
  [ "$ITER" = "2" ] && MODE="revise"

  # --- Spawn planner ---
  PLANNER_START=$(node np-tools.cjs metrics start-timestamp)
  PLANNER_MODEL=$(node np-tools.cjs resolve-model planner --profile balanced)
  # Spawn agent=np-planner tier=opus model=$PLANNER_MODEL mode=$MODE phase=$PHASE
  #   prior_findings=$LAST_FINDINGS agent_skills=$AGENT_SKILLS_PLANNER
  # (Abstract spawn-call — the host runtime resolves `tier: opus` to the
  # concrete provider model; the orchestrator does NOT hard-code a model ID.)
  PLANNER_END=$(node np-tools.cjs metrics end-timestamp)
  node np-tools.cjs metrics record \
    --agent np-planner --tier opus --resolved-model "$PLANNER_MODEL" \
    --phase "$PHASE" --plan "$PLAN_ID" --task "$TASK_ID" \
    --started "$PLANNER_START" --ended "$PLANNER_END" \
    --tokens-in "${TOKENS_IN:-0}" --tokens-out "${TOKENS_OUT:-0}" \
    --retry-count 0 --status ok --runtime "$RUNTIME"

  # --- Spawn plan-checker ---
  CHECKER_START=$(node np-tools.cjs metrics start-timestamp)
  CHECKER_MODEL=$(node np-tools.cjs resolve-model plan-checker --profile balanced)
  # Spawn agent=np-plan-checker tier=opus model=$CHECKER_MODEL phase=$PHASE plan=$PLAN_PATH
  #   agent_skills=$AGENT_SKILLS_CHECKER
  # Checker writes YAML verdict to $VERDICT_YAML_PATH; orchestrator converts
  # to JSON and passes to plan-review-append below.
  CHECKER_END=$(node np-tools.cjs metrics end-timestamp)
  node np-tools.cjs metrics record \
    --agent np-plan-checker --tier opus --resolved-model "$CHECKER_MODEL" \
    --phase "$PHASE" --plan "$PLAN_ID" --task "$TASK_ID" \
    --started "$CHECKER_START" --ended "$CHECKER_END" \
    --tokens-in "${TOKENS_IN:-0}" --tokens-out "${TOKENS_OUT:-0}" \
    --retry-count 0 --status ok --runtime "$RUNTIME"

  VERDICT_JSON_PATH="$phase_dir/.tmp-verdict-$ITER.json"
  # (verdict JSON: {status: passed|issues_found, findings: [...] })

  node np-tools.cjs init plan-phase plan-review-append "$PHASE" "$ITER" "$VERDICT_JSON_PATH"

  STATUS=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf-8')).status)" "$VERDICT_JSON_PATH")
  if [ "$STATUS" = "passed" ]; then
    break
  fi

  LAST_FINDINGS="$VERDICT_JSON_PATH"

  if [ "$ITER" = "2" ]; then
    # --- Iteration-2 escalation gate (D-17 verbatim) ---
    CHOICE=$(node np-tools.cjs askuser --json '{
      "type": "select",
      "header": "Plan-Checker Stall",
      "question": "Plan-Checker hat 2 Iterationen lang Fail gemeldet. Was tun?",
      "options": [
        {"label": "Plan mit Warnings committen",        "description": "PLAN.md wird committet; PLAN-REVIEW.md bleibt als Audit."},
        {"label": "Abort (Plan verwerfen)",             "description": "PLAN.md wird gelöscht, PLAN-REVIEW.md bleibt."},
        {"label": "Manuell editieren und erneut prüfen", "description": "Plan-Checker wird nach manueller Bearbeitung neu aufgerufen."}
      ]
    }')
    case "$CHOICE" in
      "Abort"*)
        node np-tools.cjs init plan-phase plan-phase-abort "$PHASE"
        exit 1
        ;;
      "Plan mit Warnings"*)
        # proceed to commit below — PLAN.md stays as-is
        break
        ;;
      "Manuell editieren"*)
        node np-tools.cjs askuser --json '{"type":"input","question":"Edit PLAN.md in your editor, then press Enter to re-check."}'
        # Re-spawn plan-checker against the edited PLAN.md; append as iter 3
        # (documented exception — user-driven, not automatic).
        # Loop exits after this branch.
        break
        ;;
    esac
  fi
done
```

## Promotion Decision (Plan 05-04)

<!-- answer_validation -->
After a successful iteration (or a "commit-with-warnings" choice), decide
whether to scaffold `tasks/` based on deterministic triggers:

```bash
PROMOTE_JSON=$(node np-tools.cjs init plan-phase plan-phase-promote-check "$PHASE")
PROMOTE=$(echo "$PROMOTE_JSON" | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).promote))")
if [ "$PROMOTE" = "true" ]; then
  mkdir -p "$phase_dir/tasks"
  # Planner's PLAN.md must contain a `## Task Promotion` section with the
  # triggers list. Plan-checker enforced that; no extra action here.
fi
```

Three triggers (any one fires → promote):
1. **parallelism** — `computeWaves(tasks).length > 1 && max(waves.length) >= 2`
2. **mixed-tiers** — `new Set(tasks.tier).size >= 2`
3. **non-linear-deps** — `tasks.some(t => t.depends_on.length >= 2)`

No override flag. Planner judgement does not promote (D-20).
<!-- /answer_validation -->

## Plan-Diff Approval Gate

<plan_diff_gate>
This gate fires only when the phase+plan already has a committed PLAN.md in HEAD (re-plan case). First-time planning (`plan_diff_required: false`) skips this section entirely. First plan-id is `${padded}-01` by convention.

```bash
PLAN_ID="${padded}-01"
if [[ "$PLAN_DIFF_REQUIRED" == "true" ]]; then
  echo "Plan-Diff: this is a re-plan — reviewing changes against HEAD:" >&2
  node np-tools.cjs plan-diff "$PHASE" "$PLAN_ID" | sed 's/^/  /'
  CHOICE=$(node np-tools.cjs askuser --json '{
    "type": "select",
    "header": "PLAN.md Re-Run — review diff",
    "question": "Approve the new PLAN.md, reject and restore HEAD, or loop the planner with feedback?",
    "options": [
      {"label": "Approve + proceed",   "description": "Keep the new PLAN.md; workflow commits it."},
      {"label": "Reject (keep old)",   "description": "Archive the new draft and restore HEAD."},
      {"label": "Edit (loop planner)", "description": "Ask the planner for a revision with your feedback."}
    ]
  }')
  case "$CHOICE" in
    "Approve"*)
      echo "approved — proceeding to commit" >&2
      ;;
    "Reject"*)
      REASON=$(node np-tools.cjs askuser --json '{"type":"input","question":"Reason for rejection?"}')
      node np-tools.cjs plan-diff --archive-rejected "$PHASE" "$PLAN_ID" --reason "$REASON"
      echo "rejected — HEAD restored, draft archived" >&2
      exit 0
      ;;
    "Edit"*)
      FEEDBACK=$(node np-tools.cjs askuser --json '{"type":"input","question":"Feedback for the planner:"}')
      export PLANNER_USER_FEEDBACK="$FEEDBACK"
      # Sentinel exit — orchestrator re-enters the Verification Loop above
      # with <user_feedback> appended to the planner prompt (Phase 5 D-15).
      exit 2
      ;;
  esac
fi
```
</plan_diff_gate>

## Commit

```bash
# Respects config.commit_docs (Phase 4 D-21).
# NN is the plan number inside the phase — first plan is 01.
git add "$phase_dir/${padded}-01-PLAN.md" "$phase_dir/${padded}-PLAN-REVIEW.md"
[ -d "$phase_dir/tasks" ] && git add "$phase_dir/tasks"
git commit -m "docs(${padded}-01): PLAN.md ready for execute"
```

## Abort path

If the user chose "Abort" at the iter-2 gate, `plan-phase-abort` already ran:
PLAN.md + `tasks/` are gone, PLAN-REVIEW.md preserved. Exit 1.

## Structured results

Return to the orchestrator:

```
status:      passed | committed-with-warnings | aborted | manual-edit | research-dispatched
iterations:  1 | 2 | 3
plan_path:   <absolute path to PLAN.md, or null on abort>
review_path: <absolute path to PLAN-REVIEW.md>
promoted:    true | false
triggers:    [parallelism, mixed-tiers, non-linear-deps]
```

`research-dispatched` (exit 42) signals the orchestrator to run
`/np:research-phase $PHASE` and re-enter `/np:plan-phase $PHASE` afterwards.
