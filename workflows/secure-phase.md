---
command: np:secure-phase
description: Threat-mitigation audit on a completed phase. Reads PLAN.md threat_model + implementation, spawns np-security-auditor (opus) to score each threat as MITIGATED/PARTIAL/UNMITIGATED/N/A, writes SECURITY.md sidecar from templates/SECURITY.md skeleton. One atomic docs commit.
---

# np:secure-phase

Produces `{phase_dir}/{padded}-SECURITY.md` via a single `np-security-auditor`
(opus) spawn. Runs AFTER `/np:execute-phase` has landed code — the audit
needs SUMMARY.md and a `<threat_model>` block in PLAN.md.

The workflow `cp`s `templates/SECURITY.md` into the sidecar BEFORE
spawning the agent; the auditor substitutes placeholders (`{N}`,
`{phase-slug}`, `{date}`) and appends per-threat scoring. The Task
spawn is wrapped in the Plan 09-05 metrics + resolve-model pattern
(D-06, D-01); `RUNTIME` is detected once and re-used by `metrics
record`. Prompts route through `np-tools.cjs askuser` (INST-03).

Pre-Phase-9 phases without `<threat_model>` degrade gracefully: the
auditor produces a best-effort audit inferred from ADRs + code patterns
(T-10-04-04 accept).

## Initialize

```bash
PHASE="$1"
if [[ -z "$PHASE" ]]; then
  echo "Usage: /np:secure-phase <phase-number>" >&2
  exit 2
fi

INIT=$(node np-tools.cjs init secure-phase "$PHASE")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
RUNTIME=$(node -e "console.log(require('./lib/runtime/index.cjs').detect().runtime)")
```

Parse JSON for: `padded_phase`, `phase_dir`, `phase_found`.

```bash
PADDED=$(echo "$INIT" | jq -r '.padded_phase // .padded')
PHASE_DIR=$(echo "$INIT" | jq -r '.phase_dir')
PHASE_FOUND=$(echo "$INIT" | jq -r '.phase_found')
SECURITY_PATH="${PHASE_DIR}/${PADDED}-SECURITY.md"
SUMMARY_PATH="${PHASE_DIR}/${PADDED}-SUMMARY.md"
PLAN_PATH_GLOB="${PHASE_DIR}/${PADDED}-*-PLAN.md"
TEMPLATE_PATH="templates/SECURITY.md"
PLAN_ID="${PADDED}-secure-phase"
TASK_ID="${PADDED}-secure-phase"
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

### Gate 2 — SECURITY.md already exists

If a prior audit is present, let the user choose Re-run / View / Skip.
The `cp` step only runs in the Re-run branch — View or Skip never
overwrites a user-edited sidecar (T-10-04-01 mitigation).

```bash
RERUN="false"
if [[ -f "$SECURITY_PATH" ]]; then
  CHOICE=$(node np-tools.cjs askuser --json '{
    "type": "select",
    "header": "Existing SECURITY.md",
    "question": "SECURITY.md already exists for Phase '"$PHASE"'. What would you like to do?",
    "options": [
      {"label": "Re-run — replace the current audit", "description": "Re-runs np-security-auditor and overwrites the existing file."},
      {"label": "View — display current audit and exit", "description": "Reads the file and exits without changes."},
      {"label": "Skip — keep current audit and exit", "description": "Leaves the file untouched."}
    ]
  }')
  case "$CHOICE" in
    "View"*)   cat "$SECURITY_PATH"; exit 0 ;;
    "Skip"*)   exit 0 ;;
    "Re-run"*) RERUN="true" ;;
  esac
fi
```

### Gate 3 — Template present

```bash
if [[ ! -f "$TEMPLATE_PATH" ]]; then
  echo "Error: $TEMPLATE_PATH missing; Plan 10-01-T03 should have ported it." >&2
  echo "Re-run 'npx nubos-pilot install' or restore templates/SECURITY.md from source." >&2
  exit 1
fi
```

</pre_flight>

## Load Template

Copy `templates/SECURITY.md` into the sidecar ONLY when absent OR user
chose Re-run. The agent substitutes `{N}` / `{phase-slug}` / `{date}`
at write time — the workflow never pre-substitutes.

```bash
if [[ ! -f "$SECURITY_PATH" || "$RERUN" == "true" ]]; then
  cp "$TEMPLATE_PATH" "$SECURITY_PATH"
fi
```

## Extract Threat Model

The `np-security-auditor` agent reads every
`${PHASE_DIR}/${PADDED}-*-PLAN.md`, extracts the `<threat_model>`
block, and consolidates into a unified audit. The workflow passes only
the glob + phase dir — the agent parses via `Read` / `Grep`.

## Spawn np-security-auditor (opus)

```bash
START=$(node np-tools.cjs metrics start-timestamp)
MODEL=$(node np-tools.cjs resolve-model np-security-auditor --profile balanced)
# Spawn agent=np-security-auditor model=$MODEL
#   input: plan_path_glob=$PLAN_PATH_GLOB, summary_path=$SUMMARY_PATH,
#          security_path=$SECURITY_PATH, template_path=$TEMPLATE_PATH,
#          phase_dir=$PHASE_DIR, phase=$PHASE, padded=$PADDED
#   output: $SECURITY_PATH with scored threats (MITIGATED / PARTIAL /
#           UNMITIGATED / N/A), using templates/SECURITY.md as skeleton.
Task(
  subagent_type="np-security-auditor",
  model="$MODEL",
  prompt="<files_to_read>${PLAN_PATH_GLOB} ${SUMMARY_PATH} ${TEMPLATE_PATH} CLAUDE.md PROJECT.md</files_to_read><config>plan_path_glob=$PLAN_PATH_GLOB,summary_path=$SUMMARY_PATH,security_path=$SECURITY_PATH,template_path=$TEMPLATE_PATH,phase_dir=$PHASE_DIR,phase=$PHASE,padded=$PADDED</config>"
)
END=$(node np-tools.cjs metrics end-timestamp)
node np-tools.cjs metrics record \
  --agent np-security-auditor --tier opus --resolved-model "$MODEL" \
  --phase "$PHASE" --plan "$PLAN_ID" --task "$TASK_ID" \
  --started "$START" --ended "$END" \
  --tokens-in "${TOKENS_IN:-0}" --tokens-out "${TOKENS_OUT:-0}" \
  --retry-count 0 --status ok --runtime "$RUNTIME"
```

## Validation Gate

```bash
if [[ ! -f "$SECURITY_PATH" ]]; then
  CHOICE=$(node np-tools.cjs askuser --json '{
    "type": "select",
    "header": "SECURITY.md missing",
    "question": "np-security-auditor did not write SECURITY.md. What would you like to do?",
    "options": [
      {"label": "Re-run np-security-auditor", "description": "Spawn the auditor once more."},
      {"label": "Abort",                      "description": "Exit without committing."}
    ]
  }')
  case "$CHOICE" in "Abort") exit 1 ;; esac
fi
```

## Commit

```bash
node np-tools.cjs commit "docs(${PADDED}): add security audit report" --files "$SECURITY_PATH"
```

One atomic docs commit per ADR-0004. The commit helper routes through
`lib/git.cjs.assertCommittablePaths` (gitignore-guard) before staging.

## Scope Guardrail

<scope_guardrail>
**Do:**
- Run `np-security-auditor` exactly once per invocation (single-pass audit).
- Emit a metrics record AFTER the Task spawn (D-06).
- Resolve MODEL via `np-tools.cjs resolve-model np-security-auditor --profile balanced` — no hardcoded IDs.
- Use `np-tools.cjs askuser` for every prompt (INST-03 invariant).
- `cp templates/SECURITY.md` into the sidecar BEFORE spawning the agent.
- Only overwrite existing SECURITY.md on Re-run choice (T-10-04-01).
- Abort early when phase_dir or SUMMARY.md is absent.
- Treat implementation files as READ-ONLY (D-20 SC-5).

**Don't:**
- Run this workflow on a phase without SUMMARY.md.
- Invoke host-specific prompt tools directly — route through `np-tools.cjs askuser`.
- Overwrite a user-edited SECURITY.md without the Re-run gate (T-10-04-01).
- Construct phase paths from raw `$1` — consume `padded_phase` / `phase_dir`
  from `np-tools.cjs init` (SAFE_PHASE_RE enforced upstream, T-10-04-03).
- Skip the metrics record block (D-06).
- Inject raw secret values into the agent prompt (T-10-04-02 defence-in-depth).
- Spawn any additional agent beyond `np-security-auditor`.
</scope_guardrail>

## Output

- `{phase_dir}/{padded}-SECURITY.md` — threat register with
  MITIGATED / PARTIAL / UNMITIGATED / N/A scoring, Trust Boundaries,
  Accepted Risks log, Security Audit Trail. Frontmatter carries
  `threats_total`, `mitigated`, `partial`, `unmitigated`, `threats_open`.
- 1 metrics record in `.nubos-pilot/metrics/phase-${PHASE}.jsonl`.
- One atomic `docs(${PADDED}): add security audit report` git commit.
