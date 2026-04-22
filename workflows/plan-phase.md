---
command: np:plan-phase
description: Plans a milestone (M<NNN>) — breaks it into slices (waves) and tasks. Spawns np-planner (opus) + np-plan-checker (opus), 2-iteration verification, then scaffolds every task file.
argument-hint: <milestone-number> [--research] [--repromote]
---

# np:plan-phase

**Semantic:** `/np:plan-phase 1` plans **Milestone M001** entirely — the milestone's CONTEXT/ROADMAP/META, every slice's PLAN/ASSESSMENT/UAT, and scaffolds every task file under `slices/S<NNN>/tasks/T<NNNN>/`.

A "phase" in this workflow's name equals a **milestone** . Within a milestone, the planner produces:

- **Slices** = execution waves. All tasks inside one slice run in parallel; slices run serially.
- **Tasks** = atomic executor units (one commit each).

Output layout:
```
.nubos-pilot/milestones/M001/
  M001-CONTEXT.md         ← from /np:discuss-phase (not overwritten)
  M001-ROADMAP.md         ← slice list + execution order
  M001-META.json
  slices/
    S001/
      S001-ASSESSMENT.md
      S001-PLAN.md        ← contains all <task> blocks inline
      S001-RESEARCH.md    ← optional, from /np:research-phase
      S001-UAT.md
      tasks/
        T0001/T0001-PLAN.md
        T0001/T0001-SUMMARY.md
        T0002/T0002-PLAN.md
        ...
    S002/
      ...
```

## Initialize

### Parse Arguments

```bash
PHASE=""
RESEARCH_FLAG=0
REPROMOTE_FLAG=0
for arg in "$@"; do
  case "$arg" in
    --research)  RESEARCH_FLAG=1 ;;
    --repromote) REPROMOTE_FLAG=1 ;;
    --*)         echo "Unknown flag: $arg" >&2; exit 2 ;;
    *)           [[ -z "$PHASE" ]] && PHASE="$arg" ;;
  esac
done
if [[ -z "$PHASE" ]]; then
  echo "Usage: /np:plan-phase <milestone-number> [--research] [--repromote]" >&2
  exit 2
fi
```

### Repromote short-circuit

When `--repromote` is set, skip every gate and the verification loop. Read every existing `S<NNN>-PLAN.md` under the milestone, rescaffold task dirs + files. No planner, no plan-checker, no new commits.

```bash
if [[ "$REPROMOTE_FLAG" == "1" ]]; then
  SCAFFOLD_JSON=$(node .nubos-pilot/bin/np-tools.cjs init plan-milestone scaffold-all-tasks "$PHASE")
  if [[ "$SCAFFOLD_JSON" == @file:* ]]; then SCAFFOLD_JSON=$(cat "${SCAFFOLD_JSON#@file:}"); fi
  echo "repromote: $SCAFFOLD_JSON" >&2
  exit 0
fi
```

### Read milestone state

```bash
LANG_DIRECTIVE=$(node .nubos-pilot/bin/np-tools.cjs lang-directive)
INIT=$(node .nubos-pilot/bin/np-tools.cjs init plan-milestone init "$PHASE")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
AGENT_SKILLS_PLANNER=$(node .nubos-pilot/bin/np-tools.cjs agent-skills planner 2>/dev/null)
AGENT_SKILLS_CHECKER=$(node .nubos-pilot/bin/np-tools.cjs agent-skills plan-checker 2>/dev/null)
RUNTIME=$(node .nubos-pilot/bin/np-tools.cjs detect-runtime)
```

**Language (SSOT = `.nubos-pilot/config.json` → `response_language`).**
`$LANG_DIRECTIVE` is authoritative. Obey it for all user-facing output,
askuser prompts, status updates, and any narrative text the spawned planner
or plan-checker subagents emit. Pass `$LANG_DIRECTIVE` into their spawn
prompts as a system-level rule. This supersedes any directive in CLAUDE.md.

Parse JSON for: `milestone`, `milestone_id`, `milestone_dir`, `milestone_context_path`, `milestone_roadmap_path`, `milestone_meta_path`, `name`, `goal`, `requirements`, `success_criteria`, `has_context`, `has_roadmap`, `has_meta`, `existing_slices[]`, `planner_tier`, `checker_tier`, `text_mode`, `text_mode_source`, `agent_skills`.

**Askuser routing.** Every `node .nubos-pilot/bin/np-tools.cjs askuser …` block below is a spec, not a literal command. Pick the path once at Initialize:
- **Claude Code** (native `AskUserQuestion` tool is available): parse the JSON spec and call `AskUserQuestion` directly. `select` → `multiSelect: false`; `multiselect` → `multiSelect: true`; `confirm` → `options: [{label: "Yes"}, {label: "No"}]`; `input` → ask free-form in chat. Use a short `header` (≤12 chars).
- **`text_mode == true`** (INIT payload): skip every askuser block and render questions as plain-text numbered lists. Opt-in via `.nubos-pilot/config.json` → `workflow.text_mode`.
- **Other runtime with TTY** (Codex, Gemini, …): execute the shell `askuser` block verbatim.

`PLAN_ID` and `TASK_ID` default to `${milestone_id}-plan` / `${milestone_id}-planner-run` for the metrics records.

## Pre-Flight Guards

### Gate 1 — Missing M<NNN>-CONTEXT.md

If `has_context == false`:

```bash
CHOICE=$(node .nubos-pilot/bin/np-tools.cjs askuser --json '{
  "type": "select",
  "header": "Missing M'"$PHASE"'-CONTEXT.md",
  "question": "Milestone CONTEXT.md is not present. Continue?",
  "options": [
    {"label": "Run /np:discuss-phase first", "description": "Recommended — capture user decisions before planning."},
    {"label": "Continue without CONTEXT.md", "description": "Not recommended — planner works from roadmap goal alone."},
    {"label": "Abort",                       "description": "Exit without changes."}
  ]
}')
case "$CHOICE" in
  "Run /np:discuss-phase"*) echo "Run: /np:discuss-phase $PHASE"; exit 0 ;;
  "Abort")                  exit 0 ;;
esac
```

### Gate 1b — Empty success_criteria

If `success_criteria.length == 0`:

```bash
CHOICE=$(node .nubos-pilot/bin/np-tools.cjs askuser --json '{
  "type": "select",
  "header": "No SCs in roadmap.yaml",
  "question": "Milestone has no success_criteria in roadmap.yaml. Downstream /np:verify-work will produce an empty VERIFICATION.md. How to proceed?",
  "options": [
    {"label": "Run /np:discuss-phase first", "description": "Recommended — np-sc-extractor derives SCs from CONTEXT.md + goal + requirements and writes them to roadmap.yaml."},
    {"label": "Continue anyway",             "description": "Plan the milestone without SCs; you must back-fill them before /np:verify-work."},
    {"label": "Abort",                       "description": "Exit without changes."}
  ]
}')
case "$CHOICE" in
  "Run /np:discuss-phase"*) echo "Run: /np:discuss-phase $PHASE"; exit 0 ;;
  "Abort")                  exit 0 ;;
esac
```

The planner will still emit a plan without SCs, but you are consciously opting into a known-broken verify-work path. The safer default is always to re-run `/np:discuss-phase` — Step 6b there spawns `np-sc-extractor` which populates `roadmap.yaml` directly.

### Gate 2 — Missing slice RESEARCH.md

Research is per-slice  (`slices/S<NNN>/S<NNN>-RESEARCH.md`). The planner can plan without research, but if the roadmap config requires it, ask. The `--research` flag auto-dispatches `/np:research-phase` before re-entering.

```bash
if [[ "$RESEARCH_FLAG" == "1" ]]; then
  echo "research-auto: dispatching /np:research-phase $PHASE before planning" >&2
  exit 42
fi
```

**Exit code 42 contract:** orchestrator sees exit 42 → runs `/np:research-phase $PHASE` → re-enters `/np:plan-phase $PHASE` without the `--research` flag.

### Gate 3 — Milestone already planned

If any slice has a `has_plan == true`:

```bash
CHOICE=$(node .nubos-pilot/bin/np-tools.cjs askuser --json '{
  "type": "select",
  "header": "Milestone already planned",
  "question": "One or more slices already have S<NNN>-PLAN.md. Overwrite?",
  "options": [
    {"label": "Overwrite", "description": "Archive existing slice plans; replan the milestone."},
    {"label": "Repromote", "description": "Skip planner — just rescaffold task files from existing slice plans."},
    {"label": "Abort",     "description": "Exit without changes."}
  ]
}')
case "$CHOICE" in
  "Abort") exit 0 ;;
  "Repromote")
    node .nubos-pilot/bin/np-tools.cjs init plan-milestone scaffold-all-tasks "$PHASE" >&2
    exit 0
    ;;
  "Overwrite")
    node .nubos-pilot/bin/np-tools.cjs init plan-milestone abort "$PHASE"
    ;;
esac
```

## Downstream Awareness

**Milestone artefacts feed into:**

1. **plan-checker** — Goal-backward verification at milestone + slice + task level.
2. **executor** (`/np:execute-phase`) — Reads each slice's `S<NNN>-PLAN.md` + scaffolded `tasks/T<NNNN>/T<NNNN>-PLAN.md` as prompts. Dispatches one executor per task, all tasks of a slice in parallel.
3. **verifier** (`/np:validate-phase`) — Re-runs goal-backward checks per slice UAT file.

**PLAN-REVIEW.md** lives at milestone level (`M<NNN>-PLAN-REVIEW.md`) — append-only audit trail across slices.

## Scope Guardrail

**Do:**
- Spawn planner → plan-checker in strict sequence.
- Append every verdict to `M<NNN>-PLAN-REVIEW.md` before deciding pass/fail.
- Commit milestone artefacts only after a `passed` verdict OR an explicit "commit-with-warnings" user choice on the iter-2 gate.
- Run `scaffold-all-tasks` after commit — every `<task>` in every slice becomes a `tasks/T<NNNN>/T<NNNN>-PLAN.md` + `T<NNNN>-SUMMARY.md`.

**Don't:**
- Run a third planner iteration. The loop is fixed at 2 rounds.
- Scaffold task files manually — always via `np-tools.cjs init plan-milestone scaffold-all-tasks <N>`.
- Write task files directly — the planner writes slice plans; the scaffolder writes task files.
- Invoke host-specific prompt tools directly. Always `np-tools.cjs askuser --json …`.

## Verification Loop

```bash
LAST_FINDINGS=""
for ITER in 1 2; do
  MODE="initial"
  [ "$ITER" = "2" ] && MODE="revise"

  # --- Spawn planner ---
  PLANNER_START=$(node .nubos-pilot/bin/np-tools.cjs metrics start-timestamp)
  PLANNER_MODEL=$(node .nubos-pilot/bin/np-tools.cjs resolve-model np-planner --profile frontier)
  # Spawn agent=np-planner tier=opus model=$PLANNER_MODEL mode=$MODE milestone=$PHASE
  #   milestone_dir=$milestone_dir goal=$goal requirements=$requirements
  #   prior_findings=$LAST_FINDINGS agent_skills=$AGENT_SKILLS_PLANNER
  PLANNER_END=$(node .nubos-pilot/bin/np-tools.cjs metrics end-timestamp)
  node .nubos-pilot/bin/np-tools.cjs metrics record \
    --agent np-planner --tier opus --resolved-model "$PLANNER_MODEL" \
    --phase "$PHASE" --plan "${milestone_id}-plan" --task "${milestone_id}-planner-run" \
    --started "$PLANNER_START" --ended "$PLANNER_END" \
    --tokens-in "${TOKENS_IN:-0}" --tokens-out "${TOKENS_OUT:-0}" \
    --retry-count 0 --status ok --runtime "$RUNTIME"

  # --- Spawn plan-checker ---
  CHECKER_START=$(node .nubos-pilot/bin/np-tools.cjs metrics start-timestamp)
  CHECKER_MODEL=$(node .nubos-pilot/bin/np-tools.cjs resolve-model np-plan-checker --profile frontier)
  # Spawn agent=np-plan-checker tier=opus model=$CHECKER_MODEL milestone=$PHASE
  #   milestone_dir=$milestone_dir agent_skills=$AGENT_SKILLS_CHECKER
  # Checker writes YAML verdict; orchestrator converts to JSON.
  CHECKER_END=$(node .nubos-pilot/bin/np-tools.cjs metrics end-timestamp)
  node .nubos-pilot/bin/np-tools.cjs metrics record \
    --agent np-plan-checker --tier opus --resolved-model "$CHECKER_MODEL" \
    --phase "$PHASE" --plan "${milestone_id}-plan" --task "${milestone_id}-planner-run" \
    --started "$CHECKER_START" --ended "$CHECKER_END" \
    --tokens-in "${TOKENS_IN:-0}" --tokens-out "${TOKENS_OUT:-0}" \
    --retry-count 0 --status ok --runtime "$RUNTIME"

  VERDICT_JSON_PATH="$milestone_dir/.tmp-verdict-$ITER.json"
  # (verdict JSON: {status: passed|issues_found, findings: [...] })

  # (Plan-review append uses the milestone-id form — append-only audit)
  # Future: move to plan-milestone plan-review-append verb.

  STATUS=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf-8')).status)" "$VERDICT_JSON_PATH")
  if [ "$STATUS" = "passed" ]; then
    break
  fi

  LAST_FINDINGS="$VERDICT_JSON_PATH"

  if [ "$ITER" = "2" ]; then
    CHOICE=$(node .nubos-pilot/bin/np-tools.cjs askuser --json '{
      "type": "select",
      "header": "Plan-Checker Stall",
      "question": "Plan-Checker hat 2 Iterationen lang Fail gemeldet. Was tun?",
      "options": [
        {"label": "Plan mit Warnings committen",        "description": "Milestone-Artefakte werden committet; Audit bleibt."},
        {"label": "Abort (Plan verwerfen)",             "description": "Slice-Verzeichnisse werden entfernt, Milestone-Dir bleibt."},
        {"label": "Manuell editieren und erneut prüfen", "description": "Plan-Checker wird nach manueller Bearbeitung neu aufgerufen."}
      ]
    }')
    case "$CHOICE" in
      "Abort"*)
        node .nubos-pilot/bin/np-tools.cjs init plan-milestone abort "$PHASE"
        exit 1
        ;;
      "Plan mit Warnings"*) break ;;
      "Manuell editieren"*)
        node .nubos-pilot/bin/np-tools.cjs askuser --json '{"type":"input","question":"Edit slice plans in your editor, then press Enter to re-check."}'
        break
        ;;
    esac
  fi
done
```

## Scaffold Task Files

After a successful verification (or "commit-with-warnings"), scaffold every `<task>` block into its own directory + files:

```bash
SCAFFOLD_JSON=$(node .nubos-pilot/bin/np-tools.cjs init plan-milestone scaffold-all-tasks "$PHASE")
if [[ "$SCAFFOLD_JSON" == @file:* ]]; then SCAFFOLD_JSON=$(cat "${SCAFFOLD_JSON#@file:}"); fi
echo "scaffold-all-tasks → $SCAFFOLD_JSON" >&2
```

The scaffolder:
- reads every `slices/S<NNN>/S<NNN>-PLAN.md`
- extracts `<task>` blocks (requires `id`/`depends_on`/`wave`/`tier` attributes)
- creates `slices/S<NNN>/tasks/T<NNNN>/` directory per task
- writes `T<NNNN>-PLAN.md` (from the `<task>` body) and a stubbed `T<NNNN>-SUMMARY.md`
- is idempotent — never overwrites existing task files

## Commit

```bash
COMMIT_ARTIFACTS=$(node .nubos-pilot/bin/np-tools.cjs config-get workflow.commit_artifacts 2>/dev/null || echo "true")
if [[ "$COMMIT_ARTIFACTS" != "false" ]]; then
  git add "$milestone_dir"
  git commit -m "docs(${milestone_id}): milestone plan ready for execute"
fi
```

Commits include: all milestone-level artefacts (CONTEXT/ROADMAP/META), every slice's ASSESSMENT/PLAN/UAT, and every scaffolded task file.

## Abort path

If the user chose "Abort" at the iter-2 gate, `plan-milestone abort` removes all slice dirs but preserves the milestone dir. Exit 1.

## Structured results

Return to the orchestrator:

```
status:       passed | committed-with-warnings | aborted | manual-edit | research-dispatched | repromoted
iterations:   1 | 2 | 3
milestone:    M<NNN>
milestone_dir: <absolute path>
slice_count:  <N>
task_count:   <total tasks scaffolded>
```

`research-dispatched` (exit 42) signals the orchestrator to run `/np:research-phase $PHASE` and re-enter afterwards.
