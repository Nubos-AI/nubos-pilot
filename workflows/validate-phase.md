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

LANG_DIRECTIVE=$(node .nubos-pilot/bin/np-tools.cjs lang-directive)
INIT=$(node .nubos-pilot/bin/np-tools.cjs init verify-work init "$PHASE")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
RUNTIME=$(node .nubos-pilot/bin/np-tools.cjs detect-runtime)
MILESTONE_ID=$(echo "$INIT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).milestone_id))')

# The auditor-re-run bound is a file (see "Validation Gate" below). Clear it so a
# marker left by an earlier invocation cannot deny this run its single retry.
VALIDATION_RETRY_MARKER="${TMPDIR:-/tmp}/np-validate-retried-${MILESTONE_ID}"
rm -f "$VALIDATION_RETRY_MARKER"
```

**Language (SSOT = `.nubos-pilot/config.json` → `response_language`).**
`$LANG_DIRECTIVE` is authoritative. Obey it for user-facing output, askuser
prompts, and pass it into the np-nyquist-auditor spawn prompt so gap-fill
narrative follows the project language. Test IDs, file paths, and canonical
field names stay English. Supersedes CLAUDE.md.

Parse JSON for: `milestone`, `milestone_id`, `milestone_dir`, `milestone_name`, `slice_uat`, `text_mode`, `text_mode_source`.

**Askuser routing.** Every `node .nubos-pilot/bin/np-tools.cjs askuser …` block below is a spec, not a literal command. Pick the path once at Initialize:
- **Claude Code** (native `AskUserQuestion` tool is available): parse the JSON spec and call `AskUserQuestion` directly. `select` → `multiSelect: false`; `multiselect` → `multiSelect: true`; `confirm` → `options: [{label: "Yes"}, {label: "No"}]`; `input` → ask free-form in chat. Use a short `header` (≤12 chars).
- **`text_mode == true`** (INIT payload): skip every askuser block and render questions as plain-text numbered lists. Opt-in via `.nubos-pilot/config.json` → `workflow.text_mode`.
- **Other runtime with TTY** (Codex, Gemini, …): execute the shell `askuser` block verbatim.

```bash
MILESTONE_ID=$(echo "$INIT" | jq -r '.milestone_id')
MILESTONE_DIR=$(echo "$INIT" | jq -r '.milestone_dir')
VALIDATION_PATH="${MILESTONE_DIR}/${MILESTONE_ID}-VALIDATION.md"
TEMPLATE_PATH=$(node .nubos-pilot/bin/np-tools.cjs template-path VALIDATION)
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
    *)
      echo "[np:validate-phase] unrecognised answer: '$CHOICE' — aborting rather than silently keeping the existing VALIDATION.md." >&2
      exit 1
      ;;
  esac
fi
```

### Gate 3 — Template present

```bash
if [[ -z "$TEMPLATE_PATH" || ! -f "$TEMPLATE_PATH" ]]; then
  echo "Error: VALIDATION template not resolvable via np-tools.cjs template-path." >&2
  echo "Re-run 'npx nubos-pilot install' or check the package's templates/ dir." >&2
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

## Output-Schema (pre-spawn injection)

The auditor MUST produce `M<NNN>-VALIDATION.md` conforming to the `validation` output schema (frontmatter `phase`, `requirements_total`, `covered`, `under_sampled`, `uncovered`, `nyquist_compliant`, `status`; body sections `## Summary`, `## Covered`, `## Under-Sampled`, `## Uncovered`). The aggregator in `/np:close-project` reads the frontmatter — body word-grep is gone. Inject the schema into the spawn prompt:

```bash
VALIDATION_SCHEMA=$(node .nubos-pilot/bin/np-tools.cjs output-lint prompt --schema validation)
```

Pass `$VALIDATION_SCHEMA` as a literal section in the np-nyquist-auditor spawn prompt (heading "## Output Schema — validation"). The agent has the schema contract before it writes.

## Spawn np-nyquist-auditor (haiku)

The auditor reads `REQUIREMENTS.md`, filters to the milestone's declared requirement IDs (from `roadmap.yaml milestones[].requirements`), and scans every task PLAN.md frontmatter `requirements:` field plus every slice's SUMMARY.md for cross-reference coverage. It then inspects test files for each requirement ID.

```bash
START=$(node .nubos-pilot/bin/np-tools.cjs metrics start-timestamp)
MODEL=$(node .nubos-pilot/bin/np-tools.cjs resolve-model np-nyquist-auditor --profile frontier)
AUDITOR_KIND=$(node .nubos-pilot/bin/np-tools.cjs resolve-model np-nyquist-auditor --json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).kind||"native")}catch{console.log("native")}})')

# Build the read list from the init payload:
SLICE_PLANS=$(find "$MILESTONE_DIR/slices" -maxdepth 2 -name 'S*-PLAN.md' 2>/dev/null)
SLICE_SUMMARIES=$(find "$MILESTONE_DIR/slices" -maxdepth 2 -name 'S*-SUMMARY.md' 2>/dev/null)
TASK_PLANS=$(find "$MILESTONE_DIR/slices" -path '*/tasks/*/T*-PLAN.md' 2>/dev/null)
TASK_SUMMARIES=$(find "$MILESTONE_DIR/slices" -path '*/tasks/*/T*-SUMMARY.md' 2>/dev/null)

if [ "$AUDITOR_KIND" = "openai-compat" ]; then
  # Off-host (ADR-0021): np-nyquist-auditor is NOT Rule-9-audited and writes ONLY
  # $VALIDATION_PATH (M<NNN>-VALIDATION.md) under .nubos-pilot/ (inside the repo
  # cwd — NOT live code), so it runs off-host with the default cwd: Read/Grep/Glob
  # over the repo + Write confined to cwd. NO --allow-bash, NO worktree. It writes
  # the file from templates/VALIDATION.md exactly as the native auditor does (the
  # orchestrator's output-lint check is unchanged). spawn-offhost self-records.
  AUDITOR_PROMPT="${TMPDIR:-/tmp}/np-offhost-nyquist-${MILESTONE_ID}.md"
  # … render the SAME auditor prompt (read list above + $VALIDATION_SCHEMA +
  #   template_path + requirements_path + the EXACT output path $VALIDATION_PATH)
  #   PLUS $LANG_DIRECTIVE into "$AUDITOR_PROMPT" …
  node .nubos-pilot/bin/np-tools.cjs spawn-offhost \
    --agent np-nyquist-auditor --task-file "$AUDITOR_PROMPT" \
    --phase "$PHASE" --plan "$PLAN_ID" --task "$TASK_ID" >/dev/null
else
  # Spawn agent=np-nyquist-auditor model=$MODEL (native host spawn)
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
fi
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
  case "$CHOICE" in
    "Re-run np-nyquist-auditor")
      # This branch used to be missing entirely: the option was offered, fell
      # through the case, and the workflow continued WITHOUT VALIDATION.md.
      VALIDATION_RETRY_MARKER="${TMPDIR:-/tmp}/np-validate-retried-${MILESTONE_ID}"
      if [[ -f "$VALIDATION_RETRY_MARKER" ]]; then
        echo "[np:validate-phase] auditor re-run already attempted, VALIDATION.md still missing — aborting." >&2
        exit 1
      fi
      : > "$VALIDATION_RETRY_MARKER"
      echo "[np:validate-phase] re-running np-nyquist-auditor per user choice." >&2
      ;;
    "Abort") exit 1 ;;
    *)
      # No silent fall-through: an unrecognised answer must never be read as
      # "proceed without VALIDATION.md".
      echo "[np:validate-phase] unrecognised dialog answer: '$CHOICE' — aborting instead of validating nothing." >&2
      exit 1
      ;;
  esac
fi
```

> **ACTION CONTRACT — re-run branch:** when the case above selects `Re-run np-nyquist-auditor`, re-execute the auditor spawn block from `## Spawn` exactly once, then re-enter this gate. `$VALIDATION_RETRY_MARKER` bounds it to a single retry — never loop the spawn.
>
> The bound is a **file**, not a shell variable, and that is load-bearing. This gate and the `## Spawn np-nyquist-auditor` block are separate ```bash fences = separate shell processes. Returning to the spawn block starts a fresh shell, so the previous `VALIDATION_RETRIED=1` was gone and `${VALIDATION_RETRIED:-0}` read 0 on every re-entry — the bound could never fire and the spawn could loop forever. Only state that survives a process boundary can bound a retry that crosses one (same reasoning as `loop-state-record` for `max_rounds_override` in `execute-phase.md`: "Bash-only mutation is lost on resume"). The marker path is spelled out verbatim from `$MILESTONE_ID` — which every fence re-derives from the `init` payload — so it is reconstructible in any fence without inheriting anything.

## Hard-gate — Schema lint

Before the docs-commit, the just-written `M<NNN>-VALIDATION.md` is lint-checked against the `validation` schema. Missing frontmatter counts, broken `nyquist_compliant` invariant, missing body sections — all break the workflow here, not at `/np:close-project` aggregation time:

```bash
node .nubos-pilot/bin/np-tools.cjs output-lint check \
  --file "$VALIDATION_PATH" \
  --schema validation \
  --enforce \
  --text
LINT_RC=$?
if [[ "$LINT_RC" -ne 0 ]]; then
  echo "[np:validate-phase] VALIDATION.md violates output schema — re-spawn np-nyquist-auditor with the violation list above as feedback. Do NOT hand-edit." >&2
  exit 1
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
## Definition of Done

This workflow exits successfully only when, per [`templates/COMPLETENESS.md`](../templates/COMPLETENESS.md):

- Rule 1 (Do the whole thing) — every requirement gets a Nyquist verdict (`COVERED` / `UNDER_SAMPLED` / `UNCOVERED`); silent skips are forbidden.
- Rule 3 (Do it with tests) — verdicts cite test files + line numbers + assertion patterns; `output-lint check --schema validation --enforce` is green before commit. ADR-0017.
- Rule 12 (Boil the ocean) — `UNDER_SAMPLED` and `UNCOVERED` produce remediation guidance, not just a flag.

Any violation = workflow exits non-zero. The orchestrator does not relax these.
