---
command: np:eval-review
description: Retroactive evaluation-coverage audit of a completed AI phase. Spawns np-eval-auditor to score each planned eval dimension as COVERED/PARTIAL/MISSING against AI-SPEC.md (if present) or general best-practice rubric. Produces EVAL-REVIEW.md.
---

# np:eval-review

Produces `{phase_dir}/{padded}-EVAL-REVIEW.md` via a single `np-eval-auditor`
spawn that audits the phase's implemented AI system against its
evaluation plan. Runs AFTER `/np:execute-phase` has landed code — the
audit needs a SUMMARY.md to know what was built.

Three states (resolved by the init payload, not by this workflow):

- **State A — spec-conformance audit.** `AI-SPEC.md` and `SUMMARY.md`
  both present. The auditor scores the implementation against the
  planned eval dimensions, rubrics, guardrails, and monitoring plan.
- **State B — retroactive general audit.** `SUMMARY.md` present but no
  `AI-SPEC.md`. The auditor scores against the generic best-practice
  checklist. The output file header labels the mode explicitly
  (Pitfall 10 parallel — avoids silent drift between spec-backed and
  spec-less reviews).
- **State C — abort.** No `SUMMARY.md`. The workflow exits with a
  clear message before spawning the auditor — there is nothing to
  audit until the phase has been executed.

The single Task-spawn site is wrapped in the Plan 09-05 metrics +
resolve-model pattern (D-06, D-01). `RUNTIME` is detected once at the
top of the bash block and re-used by the `metrics record` call.

## Initialize

```bash
PHASE="$1"
if [[ -z "$PHASE" ]]; then
  echo "Usage: /np:eval-review <phase-number>" >&2
  exit 2
fi

INIT=$(node np-tools.cjs init eval-review "$PHASE")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
RUNTIME=$(node -e "console.log(require('./lib/runtime/index.cjs').detect().runtime)")
```

Parse JSON for: `phase`, `padded`, `phase_dir`, `eval_review_path`,
`summary_present`, `summary_path`, `ai_spec_path`, `has_ai_spec`,
`state`, `agents.eval_auditor`.

```bash
PADDED=$(echo "$INIT" | jq -r '.padded')
PHASE_DIR=$(echo "$INIT" | jq -r '.phase_dir')
EVAL_REVIEW_PATH=$(echo "$INIT" | jq -r '.eval_review_path')
SUMMARY_PRESENT=$(echo "$INIT" | jq -r '.summary_present')
SUMMARY_PATH=$(echo "$INIT" | jq -r '.summary_path')
AI_SPEC_PATH=$(echo "$INIT" | jq -r '.ai_spec_path')
HAS_AI_SPEC=$(echo "$INIT" | jq -r '.has_ai_spec')
STATE=$(echo "$INIT" | jq -r '.state')
PLAN_ID="${PADDED}-eval-review"
TASK_ID="${PADDED}-eval-review"
```

## Pre-Flight Gates

<pre_flight>

### Gate 1 — State C aborts before any spawn

State C means no SUMMARY.md, so the phase has not been executed and
there is nothing to audit. Exit with a clear message before any agent
is spawned or any metrics record is written.

```bash
if [[ "$STATE" == "C" ]]; then
  echo "Error: Phase $PHASE has no SUMMARY.md at $SUMMARY_PATH." >&2
  echo "The phase must be executed (/np:execute-phase) before its evals can be audited." >&2
  exit 1
fi

if [[ "$SUMMARY_PRESENT" != "true" ]]; then
  echo "Error: summary_present=false for phase $PHASE; expected state=C but got $STATE." >&2
  exit 1
fi
```

### Gate 2 — EVAL-REVIEW.md already exists

If a prior review is present, let the user choose between re-running,
viewing the current review, or skipping.

```bash
if [[ -f "$EVAL_REVIEW_PATH" ]]; then
  CHOICE=$(node np-tools.cjs askuser --json '{
    "type": "select",
    "header": "Existing EVAL-REVIEW",
    "question": "EVAL-REVIEW.md already exists for Phase '"$PHASE"'. What would you like to do?",
    "options": [
      {"label": "Re-run — replace the current review", "description": "Re-runs np-eval-auditor and overwrites the existing file."},
      {"label": "View — display current review and exit", "description": "Reads the file and exits without changes."},
      {"label": "Skip — keep current review and exit", "description": "Leaves the file untouched."}
    ]
  }')
  case "$CHOICE" in
    "View"*) cat "$EVAL_REVIEW_PATH"; exit 0 ;;
    "Skip"*) exit 0 ;;
  esac
fi
```

### Gate 3 — Label audit mode from state

```bash
case "$STATE" in
  "A") AUDIT_MODE="spec-conformance" ;;
  "B") AUDIT_MODE="retroactive-general" ;;
  *)
    echo "Error: unexpected state '$STATE' from init payload (expected A or B after Gate 1)." >&2
    exit 1
    ;;
esac
```

</pre_flight>

## Philosophy

<philosophy>
Eval plans decay the moment the first commit lands. Planned rubrics
lose their binding to code, guardrails get stubbed "for now", tracing
is wired but never turned on, and the reference dataset never leaves
the design doc. A retroactive eval-coverage audit catches all of that
in one pass and emits a ranked list of gaps with concrete remediation
steps. When an AI-SPEC.md exists, the audit is a conformance check
against planned dimensions. When it does not, the audit is a
best-practice sweep — and the mode label on EVAL-REVIEW.md makes that
difference explicit so reviewers never treat a general audit as if it
had SPEC backing.
</philosophy>

## Main Flow

Single serial spawn — the auditor is self-contained (codebase scan,
dimension scoring, infrastructure audit, report writing all happen
inside `np-eval-auditor`).

### Step 1 — Eval auditor (np-eval-auditor, haiku)

```bash
START=$(node np-tools.cjs metrics start-timestamp)
MODEL=$(node np-tools.cjs resolve-model np-eval-auditor --profile balanced)
> NOTE: Spawn agent=np-eval-auditor model=$MODEL state=$STATE mode=$AUDIT_MODE
> NOTE:   input: phase_number=$PHASE, phase_dir=$PHASE_DIR,
> NOTE:          summary_path=$SUMMARY_PATH, ai_spec_path=$AI_SPEC_PATH,
> NOTE:          has_ai_spec=$HAS_AI_SPEC, audit_mode=$AUDIT_MODE,
> NOTE:          eval_review_path=$EVAL_REVIEW_PATH
> NOTE:   output: $EVAL_REVIEW_PATH with dimension scores
> NOTE:           (COVERED/PARTIAL/MISSING), infrastructure scores,
> NOTE:           overall verdict, and a mode label
> NOTE:           ("spec-conformance" or "retroactive-general") in the
> NOTE:           header frontmatter.
END=$(node np-tools.cjs metrics end-timestamp)
node np-tools.cjs metrics record \
  --agent np-eval-auditor --tier haiku --resolved-model "$MODEL" \
  --phase "$PHASE" --plan "$PLAN_ID" --task "$TASK_ID" \
  --started "$START" --ended "$END" \
  --tokens-in "${TOKENS_IN:-0}" --tokens-out "${TOKENS_OUT:-0}" \
  --retry-count 0 --status ok --runtime "$RUNTIME"
```

## Validation Gate

After the auditor finishes, verify EVAL-REVIEW.md was written. If the
file is missing, the spawn failed silently and the user is prompted to
re-run or abort.

```bash
if [[ ! -f "$EVAL_REVIEW_PATH" ]]; then
  CHOICE=$(node np-tools.cjs askuser --json '{
    "type": "select",
    "header": "EVAL-REVIEW.md missing",
    "question": "np-eval-auditor did not write EVAL-REVIEW.md. What would you like to do?",
    "options": [
      {"label": "Re-run np-eval-auditor", "description": "Spawn the auditor once more."},
      {"label": "Abort",                  "description": "Exit without committing."}
    ]
  }')
  case "$CHOICE" in
    "Abort") exit 1 ;;
  esac
fi
```

## Commit

```bash
git add "$EVAL_REVIEW_PATH"
git commit -m "docs(${PADDED}): generate EVAL-REVIEW.md (${AUDIT_MODE})"
```

## Scope Guardrail

<scope_guardrail>
**Do:**
- Run `np-eval-auditor` exactly once per invocation (single-pass audit).
- Emit a metrics record AFTER the Task spawn (D-06).
- Resolve MODEL via `np-tools.cjs resolve-model` — no hardcoded IDs.
- Use `np-tools.cjs askuser` for every prompt (INST-03 invariant).
- Honour the `state` field from the init payload: A → spec-conformance,
  B → retroactive-general, C → abort before spawning anything.
- Label the audit mode explicitly in EVAL-REVIEW.md
  (`spec-conformance` when AI-SPEC.md exists, `retroactive-general`
  otherwise) — Pitfall 10 parallel.
- Abort early when SUMMARY.md is missing; retroactive audits are only
  meaningful against executed phases.

**Don't:**
- Run this workflow on a phase that has not been executed — there is
  nothing to audit until SUMMARY.md lands.
- Invoke host-specific prompt tools directly — always route through
  `np-tools.cjs askuser`.
- Silently treat a spec-less audit as if it had SPEC backing — the
  mode label in the output header is mandatory.
- Spawn any additional agent beyond `np-eval-auditor`; if a follow-up
  remediation pass is needed, that is the planner's job, not this
  workflow's.
- Call any tools binary other than `np-tools.cjs` (the sole CLI entry
  per Plan 09-05 D-14).
- Reference legacy homedir payload paths — those directories do not
  exist in nubos-pilot projects.
- Skip the metrics record block — the Phase-10 np:stats consumer
  expects one record per Task spawn.
- Re-derive `state` inside this workflow; state detection is the init
  CLI's responsibility (`bin/np-tools/eval-review.cjs`).
</scope_guardrail>

## Output

- `{phase_dir}/{padded}-EVAL-REVIEW.md` — per-dimension scores
  (COVERED/PARTIAL/MISSING), infrastructure scores, overall verdict,
  remediation plan, and mode label
  (`spec-conformance` or `retroactive-general`).
- 1 metrics record in `.nubos-pilot/metrics/phase-${PHASE}.jsonl`
  for the single `np-eval-auditor` Task spawn.
- One git commit when EVAL-REVIEW.md is produced successfully.
