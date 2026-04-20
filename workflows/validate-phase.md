---
command: np:validate-phase
description: Nyquist validation gap-fill on a completed milestone. For each requirement in milestone scope, verifies at least one test observes the implementation directly. Spawns np-nyquist-auditor (haiku) to score COVERED/UNDER_SAMPLED/UNCOVERED, writes M<NNN>-VALIDATION.md from templates/VALIDATION.md skeleton.
argument-hint: <milestone-number>
---

# np:validate-phase

Produces `.nubos-pilot/milestones/M<NNN>/M<NNN>-VALIDATION.md` via a single `np-nyquist-auditor` (haiku) spawn. Runs AFTER `/np:execute-phase` has landed code — the audit needs every slice's SUMMARY.md, REQUIREMENTS.md, and the milestone's declared requirement IDs to score Nyquist coverage.

Nyquist metaphor: if a requirement's observable behavior is not exercised by at least one direct assertion, the test suite under-samples it — regressions in that requirement will pass silently. The auditor scores COVERED / UNDER_SAMPLED / UNCOVERED per requirement ID and records remediation guidance for the latter two states.

## Initialize

```bash
PHASE="$1"
if [[ -z "$PHASE" ]]; then
  echo "Usage: /np:validate-phase <milestone-number>" >&2
  exit 2
fi

INIT=$(node .nubos-pilot/bin/np-tools.cjs init verify-work "$PHASE")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
RUNTIME=$(node -e "console.log(require('./lib/runtime/index.cjs').detect().runtime)")
```

Parse JSON for: `milestone`, `milestone_id`, `milestone_dir`, `milestone_name`, `slice_uat`.

```bash
MILESTONE_ID=$(echo "$INIT" | jq -r '.milestone_id')
MILESTONE_DIR=$(echo "$INIT" | jq -r '.milestone_dir')
VALIDATION_PATH="${MILESTONE_DIR}/${MILESTONE_ID}-VALIDATION.md"
TEMPLATE_PATH="templates/VALIDATION.md"
REQS_PATH=".nubos-pilot/REQUIREMENTS.md"
PLAN_ID="${MILESTONE_ID}-validate"
TASK_ID="${MILESTONE_ID}-validate"
```

## Pre-Flight Gates

<pre_flight>

### Gate 1 — Milestone has been executed

Check that at least one slice has a SUMMARY.md (indicates execution completed at least partially):

```bash
HAS_ANY_SUMMARY=$(echo "$INIT" | jq -r '[.slice_uat[] | select(.has_summary == true)] | length')
if [[ "$HAS_ANY_SUMMARY" == "0" ]]; then
  echo "Error: Milestone $MILESTONE_ID has no slice summaries on disk." >&2
  echo "Run /np:execute-phase $PHASE before auditing." >&2
  exit 1
fi
```

### Gate 2 — VALIDATION.md already exists

If a prior audit is present, let the user choose Re-run / View / Skip. The template copy only runs in the Re-run branch — View or Skip never overwrites a user-edited sidecar.

```bash
RERUN="false"
if [[ -f "$VALIDATION_PATH" ]]; then
  CHOICE=$(node .nubos-pilot/bin/np-tools.cjs askuser --json '{
    "type": "select",
    "header": "Existing VALIDATION.md",
    "question": "VALIDATION.md already exists for milestone '"$MILESTONE_ID"'. What would you like to do?",
    "options": [
      {"label": "Re-run — replace the current audit", "description": "Re-runs np-nyquist-auditor and overwrites the existing file."},
      {"label": "View — display current audit and exit", "description": "Reads the file and exits without changes."},
      {"label": "Skip — keep current audit and exit", "description": "Leaves the file untouched."}
    ]
  }')
  case "$CHOICE" in
    "View"*)   cat "$VALIDATION_PATH"; exit 0 ;;
    "Skip"*)   exit 0 ;;
    "Re-run"*) RERUN="true" ;;
  esac
fi
```

### Gate 3 — Template present

```bash
if [[ ! -f "$TEMPLATE_PATH" ]]; then
  echo "Error: $TEMPLATE_PATH missing." >&2
  echo "Re-run 'npx nubos-pilot install' or restore templates/VALIDATION.md from source." >&2
  exit 1
fi
```

</pre_flight>

## Load Template

Copy `templates/VALIDATION.md` into the sidecar ONLY when absent OR user chose Re-run.

```bash
if [[ ! -f "$VALIDATION_PATH" || "$RERUN" == "true" ]]; then
  cp "$TEMPLATE_PATH" "$VALIDATION_PATH"
fi
```

## Spawn np-nyquist-auditor (haiku)

The auditor reads `REQUIREMENTS.md`, filters to the milestone's declared requirement IDs (from `roadmap.yaml milestones[].requirements`), and scans every task PLAN.md frontmatter `requirements:` field plus every slice's SUMMARY.md for cross-reference coverage. It then inspects test files for each requirement ID.

```bash
START=$(node .nubos-pilot/bin/np-tools.cjs metrics start-timestamp)
MODEL=$(node .nubos-pilot/bin/np-tools.cjs resolve-model np-nyquist-auditor --profile frontier)

# Build the read list from the init payload:
SLICE_PLANS=$(find "$MILESTONE_DIR/slices" -maxdepth 2 -name 'S*-PLAN.md' 2>/dev/null)
SLICE_SUMMARIES=$(find "$MILESTONE_DIR/slices" -maxdepth 2 -name 'S*-SUMMARY.md' 2>/dev/null)
TASK_PLANS=$(find "$MILESTONE_DIR/slices" -path '*/tasks/*/T*-PLAN.md' 2>/dev/null)
TASK_SUMMARIES=$(find "$MILESTONE_DIR/slices" -path '*/tasks/*/T*-SUMMARY.md' 2>/dev/null)

# Spawn agent=np-nyquist-auditor model=$MODEL
#   input: slice_plans, slice_summaries, task_plans, task_summaries, validation_path,
#          template_path, requirements_path, milestone_dir, milestone, milestone_id
#   output: $VALIDATION_PATH with per-requirement Nyquist scoring
#           (COVERED / UNDER_SAMPLED / UNCOVERED), using templates/VALIDATION.md as skeleton.

END=$(node .nubos-pilot/bin/np-tools.cjs metrics end-timestamp)
node .nubos-pilot/bin/np-tools.cjs metrics record \
  --agent np-nyquist-auditor --tier haiku --resolved-model "$MODEL" \
  --phase "$PHASE" --plan "$PLAN_ID" --task "$TASK_ID" \
  --started "$START" --ended "$END" \
  --tokens-in "${TOKENS_IN:-0}" --tokens-out "${TOKENS_OUT:-0}" \
  --retry-count 0 --status ok --runtime "$RUNTIME"
```

## Validation Gate

```bash
if [[ ! -f "$VALIDATION_PATH" ]]; then
  CHOICE=$(node .nubos-pilot/bin/np-tools.cjs askuser --json '{
    "type": "select",
    "header": "VALIDATION.md missing",
    "question": "np-nyquist-auditor did not write VALIDATION.md. What would you like to do?",
    "options": [
      {"label": "Re-run np-nyquist-auditor", "description": "Spawn the auditor once more."},
      {"label": "Abort",                     "description": "Exit without committing."}
    ]
  }')
  case "$CHOICE" in "Abort") exit 1 ;; esac
fi
```

## Commit

```bash
node .nubos-pilot/bin/np-tools.cjs commit "docs(${MILESTONE_ID}): add validation audit report" --files "$VALIDATION_PATH"
```

One atomic docs commit per ADR-0004. The commit helper routes through `lib/git.cjs.assertCommittablePaths` (gitignore-guard) before staging.

## Scope Guardrail

<scope_guardrail>
**Do:**
- Run `np-nyquist-auditor` exactly once per invocation (single-pass audit).
- Emit a metrics record AFTER the Task spawn.
- Resolve MODEL via `np-tools.cjs resolve-model np-nyquist-auditor --profile frontier` — no hardcoded IDs.
- Use `np-tools.cjs askuser` for every prompt.

**Don't:**
- Rewrite `REQUIREMENTS.md`, `roadmap.yaml`, or any slice plan / task file.
- Commit anything other than the single VALIDATION.md.
- Allow the auditor to write outside `$VALIDATION_PATH`.
</scope_guardrail>

## Output

```
np:validate-phase complete.

Milestone: M<NNN>
Audit: {milestone_dir}/M<NNN>-VALIDATION.md
Coverage: <n> COVERED, <n> UNDER_SAMPLED, <n> UNCOVERED
```
