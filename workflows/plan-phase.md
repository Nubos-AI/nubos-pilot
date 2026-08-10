---
command: np:plan-phase
description: Plans a milestone (M<NNN>) — breaks it into slices (waves) and tasks. Spawns np-planner (opus) + np-plan-checker (opus), 2-iteration verification, then scaffolds every task file.
argument-hint: <milestone-number> [--research] [--architect] [--repromote]
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
ARCHITECT_FLAG=0
REPROMOTE_FLAG=0
for arg in "$@"; do
  case "$arg" in
    --research)  RESEARCH_FLAG=1 ;;
    --architect) ARCHITECT_FLAG=1 ;;
    --repromote) REPROMOTE_FLAG=1 ;;
    --*)         echo "Unknown flag: $arg" >&2; exit 2 ;;
    *)           [[ -z "$PHASE" ]] && PHASE="$arg" ;;
  esac
done
if [[ -z "$PHASE" ]]; then
  echo "Usage: /np:plan-phase <milestone-number> [--research] [--architect] [--repromote]" >&2
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
# agents.research  → whether plan-phase may dispatch /np:research-phase at all.
# agents.plan_checker → whether the adversarial np-plan-checker loop runs.
# Both are project-level kill-switches; see the ACTION CONTRACTs at their gates.
RESEARCH_ENABLED=$(node .nubos-pilot/bin/np-tools.cjs config-get agents.research 2>/dev/null || echo true)
PLAN_CHECKER_ENABLED=$(node .nubos-pilot/bin/np-tools.cjs config-get agents.plan_checker 2>/dev/null || echo true)
```

**Language (SSOT = `.nubos-pilot/config.json` → `response_language`).**
`$LANG_DIRECTIVE` is authoritative. Obey it for all user-facing output,
askuser prompts, status updates, and any narrative text the spawned planner
or plan-checker subagents emit. Pass `$LANG_DIRECTIVE` into their spawn
prompts as a system-level rule. This supersedes any directive in CLAUDE.md.

Parse JSON for: `milestone`, `milestone_id`, `milestone_dir`, `milestone_context_path`, `milestone_roadmap_path`, `milestone_meta_path`, `milestone_research_path`, `milestone_architecture_path`, `name`, `goal`, `requirements`, `success_criteria`, `has_context`, `has_roadmap`, `has_meta`, `has_research`, `has_architecture`, `existing_slices[]`, `planner_tier`, `checker_tier`, `text_mode`, `text_mode_source`, `agent_skills`.

### Evidence block (`$FILES_TO_READ`) — build it once, pass it to BOTH agents

`M<NNN>-RESEARCH.md` and `M<NNN>-ARCHITECTURE.md` are produced by
`/np:research-phase` and `/np:architect-phase` at **milestone** level. Neither the
planner nor the plan-checker discovers them on its own — an agent reads what its
`<files_to_read>` block names. A research swarm whose artefact never reaches the
planner is spend with no effect, and a plan-checker that cannot see RESEARCH.md
cannot flag a plan that contradicts a `[VERIFIED]` claim (Dimension 13.4).

```bash
FILES_TO_READ="$milestone_context_path"
[ "$has_research" = "true" ]     && FILES_TO_READ="$FILES_TO_READ
$milestone_research_path"
[ "$has_architecture" = "true" ] && FILES_TO_READ="$FILES_TO_READ
$milestone_architecture_path"
for extra in .nubos-pilot/RULES.md .nubos-pilot/codebase/INDEX.md; do
  [ -f "$extra" ] && FILES_TO_READ="$FILES_TO_READ
$extra"
done
```

**Contract:** a path enters the block only when its `has_*` flag is `true` (or the
file exists) — never name a file that is not there, an agent cannot distinguish a
missing artefact from a failed read. When `has_research` is `true` the path MUST
be in the block; dropping it is the defect this section exists to prevent
(regression-guarded by `tests/plan-phase-inputs.test.cjs`).

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
  "Continue without CONTEXT.md")
    # Falling through IS the intent here — spell it out so an unrecognised
    # answer cannot borrow the same silence.
    echo "[np:plan-phase] continuing without CONTEXT.md per user choice." >&2 ;;
  *)
    echo "[np:plan-phase] unrecognised answer: '$CHOICE' — aborting instead of guessing whether to plan without CONTEXT.md." >&2
    exit 1 ;;
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
  "Continue anyway")
    echo "[np:plan-phase] planning without success_criteria per user choice — back-fill them before /np:verify-work." >&2 ;;
  *)
    echo "[np:plan-phase] unrecognised answer: '$CHOICE' — aborting instead of guessing whether to plan without success_criteria." >&2
    exit 1 ;;
esac
```

The planner will still emit a plan without SCs, but you are consciously opting into a known-broken verify-work path. The safer default is always to re-run `/np:discuss-phase` — Step 6b there spawns `np-sc-extractor` which populates `roadmap.yaml` directly.

### Gate 2 — Missing slice RESEARCH.md

Research is per-slice  (`slices/S<NNN>/S<NNN>-RESEARCH.md`). The planner can plan without research. The `--research` flag auto-dispatches `/np:research-phase` before re-entering.

**`agents.research` kill-switch.** When `agents.research=false` the project opts
out of the research phase entirely: plan-phase does not dispatch it, and a
`--research` flag is a no-op — a project-level policy overrides a per-invocation
convenience flag, but never silently. This is the toggle's only effect; the
default (`true`) leaves `--research` working as before.

```bash
if [[ "$RESEARCH_FLAG" == "1" ]]; then
  if [ "$RESEARCH_ENABLED" = "false" ]; then
    echo "[np:plan-phase] agents.research=false — ignoring --research and planning without research (project opted out of the research phase)." >&2
  else
    echo "research-auto: dispatching /np:research-phase $PHASE before planning" >&2
    exit 42
  fi
fi
```

**Exit code 42 contract:** orchestrator sees exit 42 → runs `/np:research-phase $PHASE` → re-enters `/np:plan-phase $PHASE` without the `--research` flag. Not reached when `agents.research=false`.

### Gate 2b — Optional architecture pass (`--architect`)

The `--architect` flag auto-dispatches `/np:architect-phase` before planning, so a structural ADR pass (`M<NNN>-ARCHITECTURE.md`) is decided up front and the planner consumes it like an extension of CONTEXT.md. Dispatched AFTER research (the established flow is research → architect → plan): when both flags are set, the research re-entry strips `--research`, leaving `--architect` to dispatch on the next pass.

```bash
if [[ "$ARCHITECT_FLAG" == "1" ]]; then
  echo "architect-auto: dispatching /np:architect-phase $PHASE before planning" >&2
  exit 43
fi
```

**Exit code 43 contract:** orchestrator sees exit 43 → runs `/np:architect-phase $PHASE` → re-enters `/np:plan-phase $PHASE` without the `--architect` flag. The milestone `np-architect` stays intent-level (ADR-0019): its decisions inform the plan; they do not bake schema/filenames/code-style into `PLAN.md`.

**Researcher-Schwarm semantics (ADR-0011).** The dispatched `/np:research-phase` runs in Schwarm mode by default (`swarm.research.k=3`). The cache-bypass at Pre-flight short-circuits the swarm whenever the milestone goal + requirements match a stored learning at similarity ≥ `swarm.research.threshold` and `occurrence ≥ swarm.research.minOccurrence`. The merged consensus carries a `<consensus_meta>` block (`k`, `agreement_score`, `flagged_decisions`) which `np-plan-checker` reads to weight downstream verdicts. No additional flags needed at this site — the swarm runs automatically when `--research` is set.

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
  *)
    # Critical: falling through here reached the planner and overwrote existing
    # slice plans without the user ever having chosen "Overwrite".
    echo "[np:plan-phase] unrecognised answer: '$CHOICE' — aborting rather than overwriting existing slice plans." >&2
    exit 1 ;;
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

## Skills (Nubos library)

Before iteration 1, decide whether to pressure-test the planner output with the **`np-council`** skill (`.claude/skills/np-council/SKILL.md`). Trigger the skill on Claude Code when the plan-checker verdict at iteration 1 is `passed` BUT any of the following holds:

- Milestone touches public-facing UX, payments, auth, or data-migration.
- `>= 4` slices OR `>= 12` tasks (cross-slice dep risk).
- Goal contains a hard tradeoff ("vs", "instead of", "decide between") that the planner resolved unilaterally.

If triggered, the council pressure-tests the slice-decomposition + execution order before scaffolding. On dissent, re-enter iteration 2 with the council's findings appended to `LAST_FINDINGS`. On consensus, scaffold normally.

For non-UX, low-risk plans (≤ 3 slices, internal tooling, refactors with test coverage), skip — the 2-iteration plan-checker loop is sufficient.

## Verification Loop

**`agents.plan_checker` kill-switch.** When `agents.plan_checker=false` the
*adversarial* review loop is dropped: the planner runs exactly once, `np-plan-checker`
(Step 2b) is not spawned, and there is no second iteration. What does **not** drop is
the plan-side Trust Layer (ADR-0019) — `plan-lint` is mechanical, non-overridable, and
still runs against a synthetic pass-verdict; a critical mechanical finding with no loop
to revise it is a hard stop (post-loop guard below), never a silent pass. In short:
the toggle waives LLM judgment, never the mechanical gate. Use it only when the planner
output is known-good (e.g. after a manual fix, per the FAQ).

```bash
LAST_FINDINGS=""
LOCKED_RESOLUTION=""
CONTRADICTION_SPEC=""
CONTRADICTION_RETRIES=0
# Single pass when the adversarial checker is off; the normal 2-round loop otherwise.
PLAN_ITERS="1 2"
[ "$PLAN_CHECKER_ENABLED" = "false" ] && PLAN_ITERS="1"
for ITER in $PLAN_ITERS; do
  MODE="initial"
  [ "$ITER" = "2" ] && MODE="revise"
  CONTRADICTION_RETRIES=0

  # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  # ACTION CONTRACT — Step 2a: Spawn np-planner
  # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  # Execute EXACTLY ONE Agent tool-call (real, not bash):
  #   Agent(subagent_type="np-planner", model="$PLANNER_MODEL", prompt=<…>)
  # Prompt fields:
  #   <files_to_read>$FILES_TO_READ</files_to_read>   (CONTEXT + RESEARCH + ARCHITECTURE + RULES + codebase INDEX)
  #   <mode>$MODE</mode>                         (initial | revise)
  #   <milestone>$PHASE</milestone>
  #   <milestone_dir>$milestone_dir</milestone_dir>
  #   <goal>$goal</goal>
  #   <requirements>$requirements</requirements>
  #   <prior_findings>$LAST_FINDINGS</prior_findings>  (path to verdict JSON, R≥2)
  #   <locked_resolution>$LOCKED_RESOLUTION</locked_resolution>  (contradiction gate choice, if any)
  #   <agent_skills>$AGENT_SKILLS_PLANNER</agent_skills>
  # Agent MUST: write/update slice plans inside $milestone_dir.
  # Agent MUST: read every path in <files_to_read> before writing anything
  # (np-planner "Mandatory Initial Read"). The block is authoritative — do NOT
  # drop RESEARCH.md/ARCHITECTURE.md from it to save tokens; that is exactly how
  # a plan ends up contradicting verified research.
  # Off-host (ADR-0021): when np-planner routes to an openai-compat provider
  # (agent_routing), run it via spawn-offhost (below) INSTEAD of the Agent tool.
  # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  PLANNER_START=$(node .nubos-pilot/bin/np-tools.cjs metrics start-timestamp)
  PLANNER_MODEL=$(node .nubos-pilot/bin/np-tools.cjs resolve-model np-planner --profile frontier)
  PLANNER_KIND=$(node .nubos-pilot/bin/np-tools.cjs resolve-model np-planner --json 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).kind||"native")}catch{console.log("native")}})')
  if [ "$PLANNER_KIND" = "openai-compat" ]; then
    # np-planner is NOT Rule-9-audited and writes ONLY planning artefacts under
    # .nubos-pilot/ (inside the repo cwd — NOT live code), so it runs off-host
    # with the default cwd (repo root): Read/Grep/Glob over the whole repo + Write
    # confined to cwd. NO --allow-bash and NO worktree (there is no live-code
    # blast radius to isolate, unlike the executor). It writes slice plans into
    # $milestone_dir exactly as the native planner does — no emit-and-persist
    # contract needed. spawn-offhost records the metrics row itself.
    PLANNER_PROMPT="${TMPDIR:-/tmp}/np-offhost-planner-${milestone_id}-i${ITER}.md"
    # … render the SAME prompt the ACTION CONTRACT above describes (files_to_read,
    #   mode, milestone, milestone_dir, goal, requirements, prior_findings,
    #   locked_resolution, agent_skills) PLUS $LANG_DIRECTIVE into "$PLANNER_PROMPT" …
    node .nubos-pilot/bin/np-tools.cjs spawn-offhost \
      --agent np-planner --task-file "$PLANNER_PROMPT" \
      --phase "$PHASE" --plan "${milestone_id}-plan" >/dev/null
  else
    # → execute the Agent call per ACTION CONTRACT above (native host spawn), then:
    PLANNER_END=$(node .nubos-pilot/bin/np-tools.cjs metrics end-timestamp)
    node .nubos-pilot/bin/np-tools.cjs metrics record \
      --agent np-planner --tier opus --resolved-model "$PLANNER_MODEL" \
      --phase "$PHASE" --plan "${milestone_id}-plan" --task "${milestone_id}-planner-run" \
      --started "$PLANNER_START" --ended "$PLANNER_END" \
      --tokens-in "${TOKENS_IN:-0}" --tokens-out "${TOKENS_OUT:-0}" \
      --retry-count 0 --status ok --runtime "$RUNTIME"
  fi

  # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  # ACTION CONTRACT — Step 2a-bis: Contradiction gate (planner returned
  # `## PLAN CONTRADICTION`)
  # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  # Runs ONLY when the planner's structured return opens with `## PLAN CONTRADICTION`
  # (np-planner <contradiction_protocol>). That return means two LOCKED D-XX
  # decisions cannot both hold; choosing between them is the user's call, so the
  # planner stopped instead of picking. Derived contradictions never reach here —
  # the planner resolves those itself and records a <deviation>.
  #
  # The options are runtime data (the planner's proposed resolutions), so the spec is
  # assembled into a variable and passed as `--json "$SPEC"` — the same shape
  # execute-phase.md uses for its runtime-built askuser. Render CONTRADICTION_SPEC
  # from the planner's return: `question` carries BOTH verbatim sides plus their D-XX
  # ids, `options` are the planner's resolutions verbatim (recommended first, with
  # "(empfohlen)" appended) plus a final {"label":"Abbrechen"} entry. JSON-encode every
  # string. Render $CONTRADICTION_OPTIONS in the same pass: the identical labels, one
  # per line — the gate validates the answer against it instead of trusting any string.
  # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  # Resolution does NOT consume a review iteration: the draft that triggered the gate
  # was never checked, so nothing was reviewed and nothing is owed. Instead the
  # orchestrator returns to Step 2a and re-spawns the planner with
  # <locked_resolution> set — at most ONCE per iteration. A second contradiction in
  # the same iteration means the planner is not converging on the user's answer;
  # that is a hard stop, not a third attempt.
  if [ -n "$CONTRADICTION_SPEC" ]; then
    if [ "${CONTRADICTION_RETRIES:-0}" -ge 1 ]; then
      echo "[np:plan-phase] planner returned a second PLAN CONTRADICTION after the user already resolved one (iteration $ITER) — stopping instead of re-asking. Re-open the colliding decisions with /np:discuss-phase $PHASE." >&2
      exit 1
    fi
    CHOICE=$(node .nubos-pilot/bin/np-tools.cjs askuser --json "$CONTRADICTION_SPEC")
    # The offered labels are runtime data, so they cannot be enumerated as case arms.
    # $CONTRADICTION_OPTIONS is rendered alongside $CONTRADICTION_SPEC — one label per
    # line, byte-identical to the spec's option labels — and membership in it is what
    # makes an answer a resolution rather than an unvalidated string.
    CHOICE_KNOWN=no
    [ -n "$CHOICE" ] && printf '%s\n' "$CONTRADICTION_OPTIONS" | grep -Fqx -- "$CHOICE" && CHOICE_KNOWN=yes
    case "$CHOICE" in
      "Abbrechen"*)
        node .nubos-pilot/bin/np-tools.cjs init plan-milestone abort "$PHASE"
        exit 1
        ;;
      *)
        if [ "$CHOICE_KNOWN" = "no" ]; then
          # Accepting an unrecognised answer here would lock a "resolution" the user
          # never picked — planning one side of a user-owned decision, which is the
          # exact failure this gate exists to prevent.
          echo "[np:plan-phase] unrecognised answer at the contradiction gate: '$CHOICE' — aborting rather than picking a side." >&2
          exit 1
        fi
        LOCKED_RESOLUTION="$CHOICE"
        CONTRADICTION_SPEC=""
        CONTRADICTION_RETRIES=$(( ${CONTRADICTION_RETRIES:-0} + 1 ))
        # → return to Step 2a and re-spawn np-planner with <locked_resolution> set.
        #   Do NOT advance $ITER and do NOT spawn the plan-checker on the discarded draft.
        ;;
    esac
  fi

  # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  # ACTION CONTRACT — Step 2b: Spawn np-plan-checker (immediately after 2a)
  # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  # SKIPPED ENTIRELY when $PLAN_CHECKER_ENABLED = "false" — do NOT spawn the
  # checker in that case. The `else` branch below writes a synthetic pass-verdict
  # so the ADR-0019 plan-lint step still has a verdict file to merge into (the
  # mechanical gate is never waived; only the LLM judgment is).
  # Execute EXACTLY ONE Agent tool-call (real, not bash):
  #   Agent(subagent_type="np-plan-checker", model="$CHECKER_MODEL", prompt=<…>)
  # Prompt fields:
  #   <files_to_read>$FILES_TO_READ</files_to_read>   (same evidence block as the planner)
  #   <milestone>$PHASE</milestone>
  #   <milestone_dir>$milestone_dir</milestone_dir>
  #   <agent_skills>$AGENT_SKILLS_CHECKER</agent_skills>
  # Agent MUST: read planner output (slice plans inside $milestone_dir),
  # write YAML verdict to $milestone_dir/.tmp-verdict-$ITER.yaml. Orchestrator
  # converts YAML → JSON at $VERDICT_JSON_PATH (next bash section).
  # Off-host (ADR-0021): when np-plan-checker routes to an openai-compat provider,
  # run it via spawn-offhost (below) INSTEAD of the Agent tool.
  # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  if [ "$PLAN_CHECKER_ENABLED" = "true" ]; then
  CHECKER_START=$(node .nubos-pilot/bin/np-tools.cjs metrics start-timestamp)
  CHECKER_MODEL=$(node .nubos-pilot/bin/np-tools.cjs resolve-model np-plan-checker --profile frontier)
  CHECKER_KIND=$(node .nubos-pilot/bin/np-tools.cjs resolve-model np-plan-checker --json 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).kind||"native")}catch{console.log("native")}})')
  if [ "$CHECKER_KIND" = "openai-compat" ]; then
    # np-plan-checker is NOT Rule-9-audited and writes ONLY the verdict YAML under
    # $milestone_dir (inside the repo cwd), so it runs off-host with the default
    # cwd: Read/Grep/Glob over the repo + Write confined to cwd. NO --allow-bash,
    # NO worktree. It writes $milestone_dir/.tmp-verdict-$ITER.yaml exactly as the
    # native checker does (the orchestrator's YAML→JSON step is unchanged).
    # spawn-offhost records the metrics row itself.
    CHECKER_PROMPT="${TMPDIR:-/tmp}/np-offhost-plan-checker-${milestone_id}-i${ITER}.md"
    # … render the SAME prompt the ACTION CONTRACT above describes (files_to_read,
    #   milestone, milestone_dir, agent_skills) PLUS $LANG_DIRECTIVE, and MUST state
    #   the exact output path $milestone_dir/.tmp-verdict-$ITER.yaml, into "$CHECKER_PROMPT" …
    node .nubos-pilot/bin/np-tools.cjs spawn-offhost \
      --agent np-plan-checker --task-file "$CHECKER_PROMPT" \
      --phase "$PHASE" --plan "${milestone_id}-plan" >/dev/null
  else
    # → execute the Agent call per ACTION CONTRACT above (native host spawn), then:
    CHECKER_END=$(node .nubos-pilot/bin/np-tools.cjs metrics end-timestamp)
    node .nubos-pilot/bin/np-tools.cjs metrics record \
      --agent np-plan-checker --tier opus --resolved-model "$CHECKER_MODEL" \
      --phase "$PHASE" --plan "${milestone_id}-plan" --task "${milestone_id}-planner-run" \
      --started "$CHECKER_START" --ended "$CHECKER_END" \
      --tokens-in "${TOKENS_IN:-0}" --tokens-out "${TOKENS_OUT:-0}" \
      --retry-count 0 --status ok --runtime "$RUNTIME"
  fi
  fi  # end: if PLAN_CHECKER_ENABLED

  VERDICT_JSON_PATH="$milestone_dir/.tmp-verdict-$ITER.json"
  # (verdict JSON: {status: passed|issues_found, findings: [...] })

  # Checker off → no YAML verdict was produced. Seed a synthetic pass-verdict so
  # the ADR-0019 plan-lint merge below still runs and can force issues_found on a
  # critical mechanical finding. The LLM loop is waived; the mechanical gate is not.
  if [ "$PLAN_CHECKER_ENABLED" = "false" ]; then
    echo '{"status":"passed","findings":[]}' > "$VERDICT_JSON_PATH"
  fi

  # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  # ACTION CONTRACT — Plan-side Trust Layer (ADR-0019, non-overridable)
  # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  # Runs AFTER np-plan-checker writes its verdict, BEFORE reading STATUS.
  # Execute EXACTLY:
  #
  # (1) Run plan-lint over every PLAN.md in the milestone:
  #       PLAN_LINT_JSON=$(node .nubos-pilot/bin/np-tools.cjs plan-lint \
  #         --milestone "$milestone_id" 2>&1) || true
  #
  # (2) ALWAYS, whenever plan-lint produced any finding at all:
  #       - Write lint JSON to $milestone_dir/.tmp-plan-lint-$ITER.json
  #       - MERGE every lint finding into $VERDICT_JSON_PATH
  #     AND, only when $PLAN_LINT_CRITICAL > 0:
  #       - FORCE verdict.status = "issues_found"
  #     This step is non-negotiable. The LLM verdict cannot override
  #     mechanical findings (verify-command-unknown,
  #     parallel-task-implicit-dependency, pattern-claim-unverified etc.).
  #     Merging unconditionally is deliberate: gating the merge on critical>0
  #     silently DROPPED every major/minor lint finding, so a `major`
  #     plan-over-specifies-implementation never reached the planner in
  #     iteration 2 and the severity was decorative. Merge always; escalate
  #     status only on critical.
  #
  # (3) THEN read final STATUS from the merged verdict file.
  #
  # Rationale: ADR-0019 — mechanical truth beats LLM judgment.
  # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  PLAN_LINT_JSON=$(node .nubos-pilot/bin/np-tools.cjs plan-lint --milestone "$milestone_id" 2>&1) || true
  PLAN_LINT_CRITICAL=$(echo "$PLAN_LINT_JSON" | node -e 'process.stdin.on("data",d=>{try{const j=JSON.parse(d);console.log((j.summary&&j.summary.critical)||0)}catch{console.log(0)}})')
  PLAN_LINT_TOTAL=$(echo "$PLAN_LINT_JSON" | node -e 'process.stdin.on("data",d=>{try{const j=JSON.parse(d);console.log((j.summary&&j.summary.total)||0)}catch{console.log(0)}})')
  if [ "${PLAN_LINT_TOTAL:-0}" -gt 0 ]; then
    # Promote mechanical findings into the verdict file so iteration-2 sees them.
    echo "$PLAN_LINT_JSON" > "$milestone_dir/.tmp-plan-lint-$ITER.json"
    node -e '
      const fs = require("fs");
      const verdict = JSON.parse(fs.readFileSync(process.argv[1], "utf-8"));
      const lint    = JSON.parse(fs.readFileSync(process.argv[2], "utf-8"));
      const forceIssues = process.argv[3] === "1";
      const findings = Array.isArray(verdict.findings) ? verdict.findings.slice() : [];
      for (const f of (lint.files || []).flatMap(x => x.findings || [])) findings.push(f);
      for (const f of (lint.parallel_race_findings || [])) findings.push(f);
      verdict.findings = findings;
      if (forceIssues) verdict.status = "issues_found";
      fs.writeFileSync(process.argv[1], JSON.stringify(verdict, null, 2));
    ' "$VERDICT_JSON_PATH" "$milestone_dir/.tmp-plan-lint-$ITER.json" \
      "$([ "${PLAN_LINT_CRITICAL:-0}" -gt 0 ] && echo 1 || echo 0)"
  fi

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
      *)
        # Falling through left the iter-2 gate and scaffolded a plan the user
        # never approved, warnings and all.
        echo "[np:plan-phase] unrecognised answer at the plan-check gate: '$CHOICE' — aborting rather than committing an unapproved plan." >&2
        exit 1 ;;
    esac
  fi
done

# Post-loop mechanical hard-stop. With the adversarial checker off there is no
# iter-2 gate and no revise round, so an issues_found here can only come from the
# ADR-0019 plan-lint merge — a critical mechanical finding. It must not fall
# through to scaffolding. (Checker ON reaches here only via `break`, i.e. passed
# or an explicit user "commit-with-warnings" choice, so this never fires there.)
if [ "$PLAN_CHECKER_ENABLED" = "false" ] && [ "$STATUS" = "issues_found" ]; then
  echo "[np:plan-phase] agents.plan_checker=false and plan-lint (ADR-0019, non-overridable) found critical issues — no adversarial loop to revise them. Fix the plan and re-run, or re-enable the plan-checker. See $VERDICT_JSON_PATH." >&2
  exit 1
fi
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
## Definition of Done

This workflow exits successfully only when, per [`templates/COMPLETENESS.md`](../templates/COMPLETENESS.md):

- Rule 1 (Do the whole thing) — every slice in scope has a `S<NNN>-PLAN.md` with inline `<task>` blocks and `S<NNN>-UAT.md` acceptance.
- Rule 3 (Do it with tests) — every executor task has a `verify` command in its frontmatter.
- Rule 4 (Do it with documentation) — every milestone plan includes a doc-update task per affected module.
- Rule 6 (Never table) — `np-plan-checker` rejects "stub" / "placeholder" acceptance criteria; the loop runs until plan-checker returns `passed`.
- Rule 11 (Ship the complete thing) — plan is executor-ready; no further interpretation needed.
- Rule 5 (Genuinely impress) / ADR-0032 — the plan's requirements can all hold at once. Every mirror-an-existing-implementation instruction carries a verified `<pattern_ref>`; a contradiction between two requirements is a `critical` finding, and a contradiction between two **locked** decisions stops at the contradiction gate instead of being resolved silently.

Any violation = workflow exits non-zero. The orchestrator does not relax these.
