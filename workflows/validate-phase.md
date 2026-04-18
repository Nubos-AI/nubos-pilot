---
command: np:validate-phase
description: Nyquist validation gap-fill on a completed phase. For each requirement in phase scope, verifies at least one test observes the implementation directly. Spawns np-nyquist-auditor (haiku) to score COVERED/UNDER_SAMPLED/UNCOVERED, writes VALIDATION.md sidecar from templates/VALIDATION.md skeleton. One atomic docs commit.
---

# np:validate-phase

Produces `{phase_dir}/{padded}-VALIDATION.md` via a single `np-nyquist-auditor`
(haiku) spawn. Runs AFTER `/np:execute-phase` has landed code — the
audit needs SUMMARY.md, REQUIREMENTS.md, and the phase's declared
requirement IDs to score Nyquist coverage.

The workflow `cp`s `templates/VALIDATION.md` into the sidecar BEFORE
spawning the agent; the auditor substitutes placeholders (`{N}`,
`{phase-slug}`, `{date}`) and appends per-requirement scoring. The
Task spawn is wrapped in the Plan 09-05 metrics + resolve-model pattern
(D-06, D-01); `RUNTIME` is detected once and re-used by `metrics
record`. Prompts route through `np-tools.cjs askuser` (INST-03).

Nyquist metaphor: if a requirement's observable behavior is not
exercised by at least one direct assertion, the test suite under-samples
it — regressions in that requirement will pass silently. The auditor
scores COVERED / UNDER_SAMPLED / UNCOVERED per requirement ID and
records remediation guidance for the latter two states.

## Initialize

```bash
PHASE="$1"
if [[ -z "$PHASE" ]]; then
  echo "Usage: /np:validate-phase <phase-number>" >&2
  exit 2
fi

INIT=$(node np-tools.cjs init validate-phase "$PHASE")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
RUNTIME=$(node -e "console.log(require('./lib/runtime/index.cjs').detect().runtime)")
```

Parse JSON for: `padded_phase`, `phase_dir`, `phase_found`.

```bash
PADDED=$(echo "$INIT" | jq -r '.padded_phase // .padded')
PHASE_DIR=$(echo "$INIT" | jq -r '.phase_dir')
PHASE_FOUND=$(echo "$INIT" | jq -r '.phase_found')
VALIDATION_PATH="${PHASE_DIR}/${PADDED}-VALIDATION.md"
SUMMARY_PATH="${PHASE_DIR}/${PADDED}-SUMMARY.md"
PLAN_PATH_GLOB="${PHASE_DIR}/${PADDED}-*-PLAN.md"
TEMPLATE_PATH="templates/VALIDATION.md"
REQS_PATH=".planning/REQUIREMENTS.md"
[ -f "$REQS_PATH" ] || REQS_PATH=".nubos-pilot/REQUIREMENTS.md"
PLAN_ID="${PADDED}-validate-phase"
TASK_ID="${PADDED}-validate-phase"
```

## Pre-Flight Gates

<pre_flight>

### Gate 1 — Phase found + SUMMARY.md present

```bash
if [[ "$PHASE_FOUND" != "true" ]]; then
  echo "Error: Phase $PHASE not found in roadmap or on disk." >&2
  exit 1
fi
if [[ ! -f "$SUMMARY_PATH" ]]; then
  echo "Error: Phase $PHASE has no SUMMARY.md at $SUMMARY_PATH." >&2
  echo "Run /np:execute-phase $PHASE before auditing." >&2
  exit 1
fi
```

### Gate 2 — VALIDATION.md already exists

If a prior audit is present, let the user choose Re-run / View / Skip.
The `cp` step only runs in the Re-run branch — View or Skip never
overwrites a user-edited sidecar (T-10-04-01 mitigation).

```bash
RERUN="false"
if [[ -f "$VALIDATION_PATH" ]]; then
  CHOICE=$(node np-tools.cjs askuser --json '{
    "type": "select",
    "header": "Existing VALIDATION.md",
    "question": "VALIDATION.md already exists for Phase '"$PHASE"'. What would you like to do?",
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
  echo "Error: $TEMPLATE_PATH missing; Plan 10-01-T03 should have ported it." >&2
  echo "Re-run 'npx nubos-pilot install' or restore templates/VALIDATION.md from source." >&2
  exit 1
fi
```

</pre_flight>

## Load Template

Copy `templates/VALIDATION.md` into the sidecar ONLY when absent OR user
chose Re-run. The agent substitutes `{N}` / `{phase-slug}` / `{date}`
at write time — the workflow never pre-substitutes.

```bash
if [[ ! -f "$VALIDATION_PATH" || "$RERUN" == "true" ]]; then
  cp "$TEMPLATE_PATH" "$VALIDATION_PATH"
fi
```

## Extract Requirement IDs

The `np-nyquist-auditor` agent reads REQUIREMENTS.md at `$REQS_PATH`
(`.planning/REQUIREMENTS.md` or `.nubos-pilot/REQUIREMENTS.md`), filters
to the phase's declared requirement IDs (from roadmap.yaml
`phases[].requirements`), and scans every
`${PHASE_DIR}/${PADDED}-*-PLAN.md` task frontmatter `requirements:`
field to cross-reference coverage. The agent then inspects test files
(`**/*.test.{cjs,js,ts}`, `*.spec.ts`, `test_*.py`, `*_test.go`) via
grep/Bash for each requirement ID (T-10-04-05 mitigation: REQUIREMENTS.md
path is canonical — no user input in the path; requirement IDs come
from roadmap.yaml via `lib/roadmap.cjs`, file-locked + validated).

## Spawn np-nyquist-auditor (haiku)

```bash
START=$(node np-tools.cjs metrics start-timestamp)
MODEL=$(node np-tools.cjs resolve-model np-nyquist-auditor --profile balanced)
# Spawn agent=np-nyquist-auditor model=$MODEL
#   input: plan_path_glob=$PLAN_PATH_GLOB, summary_path=$SUMMARY_PATH,
#          validation_path=$VALIDATION_PATH, template_path=$TEMPLATE_PATH,
#          requirements_path=$REQS_PATH, phase_dir=$PHASE_DIR,
#          phase=$PHASE, padded=$PADDED
#   output: $VALIDATION_PATH with per-requirement Nyquist scoring
#           (COVERED / UNDER_SAMPLED / UNCOVERED), using
#           templates/VALIDATION.md as skeleton.
Task(
  subagent_type="np-nyquist-auditor",
  model="$MODEL",
  prompt="<files_to_read>${PLAN_PATH_GLOB} ${SUMMARY_PATH} ${TEMPLATE_PATH} ${REQS_PATH} CLAUDE.md PROJECT.md</files_to_read><config>plan_path_glob=$PLAN_PATH_GLOB,summary_path=$SUMMARY_PATH,validation_path=$VALIDATION_PATH,template_path=$TEMPLATE_PATH,requirements_path=$REQS_PATH,phase_dir=$PHASE_DIR,phase=$PHASE,padded=$PADDED</config>"
)
END=$(node np-tools.cjs metrics end-timestamp)
node np-tools.cjs metrics record \
  --agent np-nyquist-auditor --tier haiku --resolved-model "$MODEL" \
  --phase "$PHASE" --plan "$PLAN_ID" --task "$TASK_ID" \
  --started "$START" --ended "$END" \
  --tokens-in "${TOKENS_IN:-0}" --tokens-out "${TOKENS_OUT:-0}" \
  --retry-count 0 --status ok --runtime "$RUNTIME"
```

## Validation Gate

```bash
if [[ ! -f "$VALIDATION_PATH" ]]; then
  CHOICE=$(node np-tools.cjs askuser --json '{
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
node np-tools.cjs commit "docs(${PADDED}): add validation audit report" --files "$VALIDATION_PATH"
```

One atomic docs commit per ADR-0004. The commit helper routes through
`lib/git.cjs.assertCommittablePaths` (gitignore-guard) before staging.

## Scope Guardrail

<scope_guardrail>
**Do:**
- Run `np-nyquist-auditor` exactly once per invocation (single-pass audit).
- Emit a metrics record AFTER the Task spawn (D-06).
- Resolve MODEL via `np-tools.cjs resolve-model np-nyquist-auditor --profile balanced` — no hardcoded IDs.
- Use `np-tools.cjs askuser` for every prompt (INST-03 invariant).
- `cp templates/VALIDATION.md` into the sidecar BEFORE spawning the agent.
- Only overwrite existing VALIDATION.md on Re-run choice (T-10-04-01).
- Abort early when phase_dir or SUMMARY.md is absent.
- Record metrics with `--tier haiku` (np-nyquist-auditor tier in D-01).
- Treat test files and implementation files as READ-ONLY — this
  workflow is observation-only (D-20 SC-5). Remediation guidance goes
  into VALIDATION.md's `## Remediation Guidance` section, never as
  direct edits to test files.

**Don't:**
- Run this workflow on a phase without SUMMARY.md.
- Invoke host-specific prompt tools directly — route through `np-tools.cjs askuser`.
- Overwrite a user-edited VALIDATION.md without the Re-run gate (T-10-04-01).
- Construct phase paths from raw `$1` — consume `padded_phase` / `phase_dir`
  from `np-tools.cjs init` (SAFE_PHASE_RE enforced upstream, T-10-04-03).
- Construct REQUIREMENTS.md path from user input — use the canonical
  `.planning/REQUIREMENTS.md` or `.nubos-pilot/REQUIREMENTS.md` fallback
  (T-10-04-05).
- Skip the metrics record block (D-06).
- Modify test files or implementation code — the auditor is read-only;
  fixes belong to a follow-up planner pass.
- Spawn any additional agent beyond `np-nyquist-auditor`.
</scope_guardrail>

## Output

- `{phase_dir}/{padded}-VALIDATION.md` — Nyquist scoring per
  requirement (COVERED / UNDER_SAMPLED / UNCOVERED), Test Infrastructure
  section, Per-Task Verification Map, Manual-Only list, Remediation
  Guidance. Frontmatter carries `requirements_total`, `covered`,
  `under_sampled`, `uncovered`, `nyquist_compliant` boolean.
- 1 metrics record in `.nubos-pilot/metrics/phase-${PHASE}.jsonl`.
- One atomic `docs(${PADDED}): add validation audit report` git commit.
