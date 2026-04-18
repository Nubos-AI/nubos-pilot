---
command: np:ui-phase
description: Generate UI-SPEC.md for frontend phases via 2-agent revision loop (np-ui-researcher → np-ui-checker) with max 2 iterations and a PASS/FLAG/BLOCK verdict gate.
---

# np:ui-phase

Produces `{phase_dir}/{padded}-UI-SPEC.md` via a researcher → checker
revision loop (max 2 iterations). Inserts between `/np:discuss-phase` and
`/np:plan-phase` for UI-heavy phases. Locks the six visual pillars
(spacing, typography, color, copywriting, design-system, components)
BEFORE the planner creates tasks so execution stays on-brand.

Every Task-spawn site is wrapped in the Plan 09-05 metrics + resolve-model
pattern (D-06, D-01). `RUNTIME` is detected once at the top of the bash
block and re-used by every `metrics record` call.

## Initialize

```bash
PHASE="$1"
if [[ -z "$PHASE" ]]; then
  echo "Usage: /np:ui-phase <phase-number>" >&2
  exit 2
fi

INIT=$(node np-tools.cjs init ui-phase "$PHASE")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
RUNTIME=$(node -e "console.log(require('./lib/runtime/index.cjs').detect().runtime)")
```

Parse JSON for: `phase`, `padded`, `phase_dir`, `ui_spec_path`,
`has_ui_spec`, `template_path`, `max_iterations`,
`agents.ui_researcher`, `agents.ui_checker`.

```bash
PADDED=$(echo "$INIT" | jq -r '.padded')
PHASE_DIR=$(echo "$INIT" | jq -r '.phase_dir')
UI_SPEC_PATH=$(echo "$INIT" | jq -r '.ui_spec_path')
HAS_UI_SPEC=$(echo "$INIT" | jq -r '.has_ui_spec')
TEMPLATE_PATH=$(echo "$INIT" | jq -r '.template_path')
MAX_ITER=$(echo "$INIT" | jq -r '.max_iterations')
PLAN_ID="${PADDED}-ui"
TASK_ID="${PADDED}-ui"
```

## Pre-Flight Gates

<pre_flight>

### Gate 1 — UI-SPEC.md already exists

If `has_ui_spec == true`:

```bash
if [[ "$HAS_UI_SPEC" == "true" ]]; then
  CHOICE=$(node np-tools.cjs askuser --json '{
    "type": "select",
    "header": "Existing UI-SPEC",
    "question": "UI-SPEC.md already exists for Phase '"$PHASE"'. What would you like to do?",
    "options": [
      {"label": "Update — re-run researcher with existing as baseline", "description": "Re-runs the researcher→checker loop against the current spec."},
      {"label": "View — display current UI-SPEC and exit",             "description": "Reads the file and exits without changes."},
      {"label": "Skip — keep current UI-SPEC and exit",                "description": "Leaves the file untouched."}
    ]
  }')
  case "$CHOICE" in
    "View"*) cat "$UI_SPEC_PATH"; exit 0 ;;
    "Skip"*) exit 0 ;;
  esac
fi
```

</pre_flight>

## Philosophy

<philosophy>
UI-SPEC.md locks the six pillars most often under-specified in frontend
work: spacing scale (non-multiple-of-4 breaks grids), typography
(too many sizes or weights create visual noise), color (accent reserved
for "all interactive elements" defeats the 60/30/10 split), copywriting
(generic CTAs like "Submit" / "OK" ship as design debt), design-system
inventory (pull-once, re-use everywhere), and per-component contracts
(prop shape + a11y + state machine). Running this loop BEFORE
`/np:plan-phase` surfaces these decisions as an explicit artifact the
planner, executor, and ui-auditor can enforce.
</philosophy>

## Main Flow

The researcher and checker alternate for up to `$MAX_ITER` iterations.
Each iteration wraps both spawns in the Plan-09-05 metrics pattern.
The checker emits a structured JSON verdict with `overall_status` set
to `APPROVED` or `BLOCKED`; `BLOCKED` re-invokes the researcher with
the checker's issue list as feedback.

### Step 0 — Initialize UI-SPEC.md from template

```bash
if [[ "$HAS_UI_SPEC" != "true" ]]; then
  cp "$TEMPLATE_PATH" "$UI_SPEC_PATH"
fi
ITER=0
VERDICT_PATH="${PHASE_DIR}/${PADDED}-ui-checker-verdict.json"
```

### Revision Loop

> NOTE: Serial per iteration. The researcher writes UI-SPEC.md; the
> checker reads it and emits a verdict. On `BLOCKED`, loop with the
> verdict as feedback. On `APPROVED` or `$ITER >= $MAX_ITER`, exit.

```bash
while [[ "$ITER" -lt "$MAX_ITER" ]]; do
  ITER=$((ITER + 1))
  ITER_TASK_ID="${TASK_ID}-iter-${ITER}"
```

#### Step 1 — UI researcher (np-ui-researcher, sonnet)

```bash
  START=$(node np-tools.cjs metrics start-timestamp)
  MODEL=$(node np-tools.cjs resolve-model np-ui-researcher --profile balanced)
  > NOTE: Spawn agent=np-ui-researcher model=$MODEL
  > NOTE:   input: phase_number=$PHASE, ui_spec_path=$UI_SPEC_PATH, iteration=$ITER
  > NOTE:   on iter >= 2, also pass prior_verdict=$VERDICT_PATH as revision feedback
  > NOTE:   output: fully-populated UI-SPEC.md at $UI_SPEC_PATH
  END=$(node np-tools.cjs metrics end-timestamp)
  node np-tools.cjs metrics record \
    --agent np-ui-researcher --tier sonnet --resolved-model "$MODEL" \
    --phase "$PHASE" --plan "$PLAN_ID" --task "$ITER_TASK_ID" \
    --started "$START" --ended "$END" \
    --tokens-in "${TOKENS_IN:-0}" --tokens-out "${TOKENS_OUT:-0}" \
    --retry-count 0 --status ok --runtime "$RUNTIME"
```

#### Step 2 — UI checker (np-ui-checker, haiku)

```bash
  START=$(node np-tools.cjs metrics start-timestamp)
  MODEL=$(node np-tools.cjs resolve-model np-ui-checker --profile balanced)
  > NOTE: Spawn agent=np-ui-checker model=$MODEL
  > NOTE:   input: ui_spec_path=$UI_SPEC_PATH
  > NOTE:   output: structured JSON verdict written to $VERDICT_PATH
  END=$(node np-tools.cjs metrics end-timestamp)
  node np-tools.cjs metrics record \
    --agent np-ui-checker --tier haiku --resolved-model "$MODEL" \
    --phase "$PHASE" --plan "$PLAN_ID" --task "$ITER_TASK_ID" \
    --started "$START" --ended "$END" \
    --tokens-in "${TOKENS_IN:-0}" --tokens-out "${TOKENS_OUT:-0}" \
    --retry-count 0 --status ok --runtime "$RUNTIME"
```

#### Step 3 — Evaluate verdict

```bash
  OVERALL=$(jq -r '.overall_status' "$VERDICT_PATH" 2>/dev/null || echo "BLOCKED")
  VERDICT=$(jq -r '.verdict' "$VERDICT_PATH" 2>/dev/null || echo "BLOCK")
  if [[ "$OVERALL" == "APPROVED" ]]; then
    break
  fi
done
```

## Validation Gate

After the loop, inspect the final verdict. If still `BLOCKED` after
`$MAX_ITER` iterations, ask the user to accept with warnings, revise
manually, or abort. If `APPROVED`, update UI-SPEC.md frontmatter to
`status: approved` with a review timestamp.

```bash
OVERALL=$(jq -r '.overall_status' "$VERDICT_PATH" 2>/dev/null || echo "BLOCKED")

if [[ "$OVERALL" == "BLOCKED" ]]; then
  CHOICE=$(node np-tools.cjs askuser --json '{
    "type": "select",
    "header": "UI-SPEC still BLOCKED after max iterations",
    "question": "The checker still returns BLOCKED. What would you like to do?",
    "options": [
      {"label": "Accept with warnings", "description": "Proceed; unresolved issues are noted in the commit message."},
      {"label": "Revise manually",      "description": "Exit so you can edit UI-SPEC.md by hand."},
      {"label": "Abort",                "description": "Exit without committing."}
    ]
  }')
  case "$CHOICE" in
    "Abort")           exit 1 ;;
    "Revise manually") exit 0 ;;
  esac
else
  REVIEWED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  node np-tools.cjs frontmatter-set "$UI_SPEC_PATH" status approved
  node np-tools.cjs frontmatter-set "$UI_SPEC_PATH" reviewed_at "$REVIEWED_AT"
fi
```

> NOTE: `frontmatter-set` is the standard nubos-pilot frontmatter editor;
> if unavailable, use an equivalent in-place sed/Write pattern per the
> adapted-port invariant (no direct host-tool edits).

## Commit

```bash
git add "$UI_SPEC_PATH"
git commit -m "docs(${PADDED}): generate UI-SPEC.md via 2-agent revision loop"
```

## Scope Guardrail

<scope_guardrail>
**Do:**
- Run researcher and checker serially per iteration (max 2 iterations).
- Emit a metrics record AFTER every Task spawn (D-06).
- Resolve every MODEL via `np-tools.cjs resolve-model` — no hardcoded IDs.
- Use `np-tools.cjs askuser` for every prompt (Phase-3 INST-03 invariant).
- Commit the final UI-SPEC.md when the checker returns APPROVED or the
  user accepts with warnings.

**Don't:**
- Invoke the host-specific prompt tool directly — always route through
  `np-tools.cjs askuser`.
- Parallelize researcher + checker — the checker reads what the
  researcher just wrote.
- Exceed `$MAX_ITER` iterations — the revision loop is bounded to
  prevent runaway costs on stubborn BLOCKs.
- Call any tools binary other than `np-tools.cjs` (the sole CLI entry
  per Plan 09-05 D-14).
- Reference legacy homedir payload paths — those directories do not
  exist in nubos-pilot projects.
- Modify UI-SPEC.md from the checker agent — the checker is read-only
  and the researcher owns writes.
- Skip any metrics record block — the Phase-10 np:stats consumer
  expects one record per Task spawn.
</scope_guardrail>

## Output

- `{phase_dir}/{padded}-UI-SPEC.md` — filled-in UI design contract with
  `status: approved` frontmatter when the checker passes.
- `{phase_dir}/{padded}-ui-checker-verdict.json` — last checker verdict
  (JSON); retained for the planner and ui-auditor to consume.
- Up to 2 × 2 = 4 metrics records in
  `.nubos-pilot/metrics/phase-${PHASE}.jsonl` (one per Task spawn per
  iteration).
- One git commit (when APPROVED or user accepts with warnings).
