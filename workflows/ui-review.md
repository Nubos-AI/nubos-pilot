---
command: np:ui-review
description: Retroactive 6-pillar visual audit of a completed phase. Spawns np-ui-auditor to score copywriting, visuals, color, typography, spacing, and experience design against UI-SPEC.md (if present) or abstract best-practice standards. Produces UI-REVIEW.md.
---

# np:ui-review

Produces `{phase_dir}/{padded}-UI-REVIEW.md` via a single `np-ui-auditor` spawn
that audits the phase's implemented frontend code. Runs AFTER
`/np:execute-phase` has landed code — the audit needs a SUMMARY.md to
know what was built.

Two modes:

- **Spec-conformance audit** — when `{padded}-UI-SPEC.md` exists (phase
  went through `/np:ui-phase`). Pillars are scored against the declared
  contract.
- **Retroactive general audit** — when no UI-SPEC is present. Pillars
  are scored against abstract 6-pillar best-practice standards. The
  output file header labels the mode explicitly (Pitfall 10 — avoids
  silent drift between spec-backed and spec-less reviews).

The single Task-spawn site is wrapped in the Plan 09-05 metrics +
resolve-model pattern (D-06, D-01). `RUNTIME` is detected once at the
top of the bash block and re-used by the `metrics record` call.

## Initialize

```bash
PHASE="$1"
if [[ -z "$PHASE" ]]; then
  echo "Usage: /np:ui-review <phase-number>" >&2
  exit 2
fi

INIT=$(node np-tools.cjs init ui-review "$PHASE")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
RUNTIME=$(node -e "console.log(require('./lib/runtime/index.cjs').detect().runtime)")
```

Parse JSON for: `phase`, `padded`, `phase_dir`, `ui_review_path`,
`summary_present`, `summary_path`, `ui_spec_path`, `has_ui_spec`,
`agents.ui_auditor`.

```bash
PADDED=$(echo "$INIT" | jq -r '.padded')
PHASE_DIR=$(echo "$INIT" | jq -r '.phase_dir')
UI_REVIEW_PATH=$(echo "$INIT" | jq -r '.ui_review_path')
SUMMARY_PRESENT=$(echo "$INIT" | jq -r '.summary_present')
SUMMARY_PATH=$(echo "$INIT" | jq -r '.summary_path')
UI_SPEC_PATH=$(echo "$INIT" | jq -r '.ui_spec_path')
HAS_UI_SPEC=$(echo "$INIT" | jq -r '.has_ui_spec')
PLAN_ID="${PADDED}-ui-review"
TASK_ID="${PADDED}-ui-review"
```

## Pre-Flight Gates

<pre_flight>

### Gate 1 — SUMMARY.md must exist

A retroactive audit requires a completed phase. If no SUMMARY.md is
present, the phase hasn't been executed yet and there is nothing to
audit.

```bash
if [[ "$SUMMARY_PRESENT" != "true" ]]; then
  echo "Error: Phase $PHASE has no SUMMARY.md at $SUMMARY_PATH." >&2
  echo "The phase must be executed (/np:execute-phase) before it can be audited." >&2
  exit 1
fi
```

### Gate 2 — UI-REVIEW.md already exists

If a prior review is present, let the user choose between re-running,
viewing the current review, or skipping.

```bash
if [[ -f "$UI_REVIEW_PATH" ]]; then
  CHOICE=$(node np-tools.cjs askuser --json '{
    "type": "select",
    "header": "Existing UI-REVIEW",
    "question": "UI-REVIEW.md already exists for Phase '"$PHASE"'. What would you like to do?",
    "options": [
      {"label": "Re-run — replace the current review", "description": "Re-runs np-ui-auditor and overwrites the existing file."},
      {"label": "View — display current review and exit", "description": "Reads the file and exits without changes."},
      {"label": "Skip — keep current review and exit", "description": "Leaves the file untouched."}
    ]
  }')
  case "$CHOICE" in
    "View"*) cat "$UI_REVIEW_PATH"; exit 0 ;;
    "Skip"*) exit 0 ;;
  esac
fi
```

### Gate 3 — Determine audit mode

```bash
if [[ "$HAS_UI_SPEC" == "true" ]]; then
  AUDIT_MODE="spec-conformance"
else
  AUDIT_MODE="retroactive-general"
fi
```

</pre_flight>

## Philosophy

<philosophy>
UI drift is invisible until you measure it. Copy regresses to "Submit"
and "OK", accent colors multiply past the 60/30/10 split, spacing
scales fragment into pixel-perfect one-offs, and empty/error/loading
states go missing. A retroactive 6-pillar audit catches all of that in
one pass and produces a ranked list of fixes. When a UI-SPEC.md exists,
the audit is a conformance check. When it doesn't, the audit is a
best-practice sweep — and the mode label on UI-REVIEW.md makes that
difference explicit so reviewers don't treat a general audit as if it
had SPEC backing.
</philosophy>

## Main Flow

Single serial spawn — the auditor is self-contained (screenshots,
pillar scoring, registry safety, report writing all happen inside
`np-ui-auditor`).

### Step 1 — UI auditor (np-ui-auditor, haiku)

```bash
START=$(node np-tools.cjs metrics start-timestamp)
MODEL=$(node np-tools.cjs resolve-model np-ui-auditor --profile balanced)
> NOTE: Spawn agent=np-ui-auditor model=$MODEL
> NOTE:   input: phase_number=$PHASE, phase_dir=$PHASE_DIR,
> NOTE:          summary_path=$SUMMARY_PATH, ui_spec_path=$UI_SPEC_PATH,
> NOTE:          has_ui_spec=$HAS_UI_SPEC, audit_mode=$AUDIT_MODE,
> NOTE:          ui_review_path=$UI_REVIEW_PATH
> NOTE:   output: $UI_REVIEW_PATH with pillar scores, top-3 fixes,
> NOTE:           and a mode label ("spec-conformance" or
> NOTE:           "retroactive-general") in the header frontmatter.
END=$(node np-tools.cjs metrics end-timestamp)
node np-tools.cjs metrics record \
  --agent np-ui-auditor --tier haiku --resolved-model "$MODEL" \
  --phase "$PHASE" --plan "$PLAN_ID" --task "$TASK_ID" \
  --started "$START" --ended "$END" \
  --tokens-in "${TOKENS_IN:-0}" --tokens-out "${TOKENS_OUT:-0}" \
  --retry-count 0 --status ok --runtime "$RUNTIME"
```

## Validation Gate

After the auditor finishes, verify UI-REVIEW.md was written and carries
the expected mode label. If the file is missing, the spawn failed
silently and the user is prompted to re-run or abort.

```bash
if [[ ! -f "$UI_REVIEW_PATH" ]]; then
  CHOICE=$(node np-tools.cjs askuser --json '{
    "type": "select",
    "header": "UI-REVIEW.md missing",
    "question": "np-ui-auditor did not write UI-REVIEW.md. What would you like to do?",
    "options": [
      {"label": "Re-run np-ui-auditor", "description": "Spawn the auditor once more."},
      {"label": "Abort",                "description": "Exit without committing."}
    ]
  }')
  case "$CHOICE" in
    "Abort") exit 1 ;;
  esac
fi
```

## Commit

```bash
git add "$UI_REVIEW_PATH"
git commit -m "docs(${PADDED}): generate UI-REVIEW.md (${AUDIT_MODE})"
```

## Scope Guardrail

<scope_guardrail>
**Do:**
- Run `np-ui-auditor` exactly once per invocation (single-pass audit).
- Emit a metrics record AFTER the Task spawn (D-06).
- Resolve MODEL via `np-tools.cjs resolve-model` — no hardcoded IDs.
- Use `np-tools.cjs askuser` for every prompt (INST-03 invariant).
- Label the audit mode explicitly in UI-REVIEW.md
  (`spec-conformance` when UI-SPEC.md exists, `retroactive-general`
  otherwise) — Pitfall 10 enforcement.
- Abort early when SUMMARY.md is missing; retroactive audits are only
  meaningful against executed phases.

**Don't:**
- Run this workflow on a phase that has not been executed — there is
  nothing to audit until SUMMARY.md lands.
- Invoke host-specific prompt tools directly — always route through
  `np-tools.cjs askuser`.
- Silently treat a spec-less audit as if it had SPEC backing — the
  mode label in the output header is mandatory.
- Spawn any additional agent beyond `np-ui-auditor`; if a follow-up
  remediation pass is needed, that is the planner's job, not this
  workflow's.
- Call any tools binary other than `np-tools.cjs` (the sole CLI entry
  per Plan 09-05 D-14).
- Reference legacy homedir payload paths — those directories do not
  exist in nubos-pilot projects.
- Skip the metrics record block — the Phase-10 np:stats consumer
  expects one record per Task spawn.
</scope_guardrail>

## Output

- `{phase_dir}/{padded}-UI-REVIEW.md` — pillar scores, top-3 priority
  fixes, detailed findings, and mode label
  (`spec-conformance` or `retroactive-general`).
- 1 metrics record in `.nubos-pilot/metrics/phase-${PHASE}.jsonl`
  for the single `np-ui-auditor` Task spawn.
- One git commit when UI-REVIEW.md is produced successfully.
