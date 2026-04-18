---
command: np:plan-milestone-gaps
description: Create corrective phases for audit gaps without touching completed phases.
---

# np:plan-milestone-gaps

Create corrective phases for gaps surfaced by phase VERIFICATION.md files or
an external audit markdown. New phases are appended to the current milestone
(or decimal-inserted after a chosen base phase) and their `depends_on` is
ALWAYS set to the *semantic* source phase — never the positional insertion
point. Completed phases are NEVER rewritten.

## Philosophy

<philosophy>
Gaps are the gap between plan and reality. When a plan's VERIFICATION.md
flags unfinished checkboxes, explicit `## Gap:` sections, or `❌` / `FAIL`
markers, the correct response is NOT to edit the originating phase — that
phase shipped, its SUMMARY.md was written, its commit landed. Instead, we
ADD a corrective phase whose `depends_on` cites the source phase, leaving the
git history linear and the downstream roadmap unmutated.
</philosophy>

## Scope Guardrail

<scope_guardrail>
This workflow ONLY touches `.nubos-pilot/roadmap.yaml` (via the lib's write
API) and `.nubos-pilot/ROADMAP.md` (regenerated atomically in the same lock).
It NEVER:

- rewrites completed phases' `depends_on` to route through the new phase
- deletes or renumbers existing phases
- reads files outside the project root (`parseAuditFile` rejects with
  `gaps-invalid-audit-path`)
- writes outside `.nubos-pilot/` or the workflow's own logs

Any proposed deviation from these invariants MUST be raised with the user
before proceeding.
</scope_guardrail>

## Downstream Awareness

<downstream_awareness>
A decimal-inserted phase (e.g. `7.1` after phase 7) is PHYSICALLY positioned
between 7 and 8 in the yaml, but the `depends_on` edges of phases 8+ are NOT
rewritten. This is load-bearing: other workflows (progress, next, the
executor's wave planner) treat the numeric edges in `depends_on` as the
authoritative dependency graph. If a user wants phase 8 to depend on `7.1`
they must edit phase 8's `depends_on` explicitly — this workflow will not do
it on their behalf, because doing so in bulk is how corrective phases
silently invalidate in-flight SUMMARY.md claims. See Phase 5 RESEARCH §
"Pitfall 5" for the full rationale.
</downstream_awareness>

## Single-Call Init

All context is gathered in one call to `np-tools.cjs init
plan-milestone-gaps`. The subcommand scans every phase's VERIFICATION.md (or
parses `--from <audit.md>` when supplied), resolves the current milestone
from STATE.md, and returns a JSON payload consumable by the rest of this
workflow.

```bash
INIT=$(node np-tools.cjs init plan-milestone-gaps "$@")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
```

The payload shape:

```json
{
  "_workflow": "plan-milestone-gaps",
  "milestoneId": "v1.0",
  "mode": "scan" | "from-file",
  "gaps": [
    {
      "source_phase": 7,
      "gap_type": "explicit" | "unchecked-box" | "fail-marker",
      "description": "…",
      "severity": "critical" | "major" | "minor"
    }
  ],
  "insertAfter": null | <integer>,
  "agent_skills": { "np-planner": <skills-payload | null> }
}
```

Extract fields with standard shell JSON handling (e.g. `jq`). All further
logic in this workflow MUST key off `INIT` — do NOT re-read files directly.

## Answer Validation

<answer_validation>
Before mutating the roadmap, confirm with the user:

1. How many gaps were found and which phases they originated from.
2. Whether to append new phases at the milestone tail (default) or to use a
   decimal insert via `--insert-after N`.
3. Whether to proceed when the gap set is empty (usually: exit).

All three confirmations use `np-tools.cjs askuser` (Pattern 2) — NEVER a
bare `AskUserQuestion` invocation. The executor hosts will route the JSON
question through whichever UI they support.
</answer_validation>

### Empty-gap short circuit

```bash
if [[ $(echo "$INIT" | jq '.gaps | length') -eq 0 ]]; then
  node np-tools.cjs askuser --json '{
    "type": "confirm",
    "prompt": "No gaps found in VERIFICATION.md scan / audit. Exit without changes?",
    "default": true
  }'
  exit 0
fi
```

### Scan-mode confirmation

```bash
MODE=$(echo "$INIT" | jq -r '.mode')
if [[ "$MODE" == "scan" ]]; then
  node np-tools.cjs askuser --json '{
    "type": "select",
    "prompt": "Gaps found via VERIFICATION.md scan. Choose how to apply them:",
    "options": [
      "Proceed — append new phases to milestone tail",
      "Abort — I want to re-run with --insert-after N",
      "Cancel"
    ]
  }'
fi
```

### From-file confirmation

```bash
if [[ "$MODE" == "from-file" ]]; then
  node np-tools.cjs askuser --json '{
    "type": "confirm",
    "prompt": "Audit file parsed. Proceed to create corrective phases?",
    "default": true
  }'
fi
```

## Apply Gap-to-Phase Conversion

All file writes are delegated to `lib/gaps.cjs#gapsToPhases`. This keeps the
workflow thin: no inline YAML mutation, no direct `atomicWriteFileSync` use,
no hand-rolled slug generation. The lib function already:

- groups gaps by `source_phase` (one new phase per unique source)
- sets `depends_on: [source_phase]` (SEMANTIC — not positional)
- calls `addPhase(milestoneId, …)` or `insertPhaseAfter(base, …)` based on
  `insertAfter`
- wraps the mutation in `withFileLock` and regenerates ROADMAP.md atomically

```bash
# Compose the apply payload and invoke the lib directly via node -e. Using
# node -e keeps this file hermetic (no spawn of a separate CLI verb for
# mutation) and delegates lock + render to lib/gaps.cjs.
node -e '
  const gaps = JSON.parse(process.env.GAPS);
  const insertAfter = process.env.INSERT_AFTER === "null" ? null : Number(process.env.INSERT_AFTER);
  const { gapsToPhases } = require("./lib/gaps.cjs");
  const created = gapsToPhases(gaps, { insertAfter });
  process.stdout.write(JSON.stringify({ created }, null, 2));
' \
  GAPS="$(echo "$INIT" | jq -c '.gaps')" \
  INSERT_AFTER="$(echo "$INIT" | jq -r '.insertAfter // "null"')"
```

## Commit the Roadmap Change

The roadmap mutation is already atomic. The workflow's final step is to
commit the updated `roadmap.yaml` + regenerated `ROADMAP.md` so the change
is preserved in git history — but ONLY when `.nubos-pilot/config.json`'s
`commit_docs` flag is `true` (default).

```bash
COMMIT_DOCS=$(node -e 'try{
  const c=require("./.nubos-pilot/config.json");
  process.stdout.write(String(c.commit_docs !== false));
}catch(e){process.stdout.write("true");}')

if [[ "$COMMIT_DOCS" == "true" ]]; then
  # Stage and commit via the git CLI (safe arg-array form; never string-concat
  # the commit message through a shell). Empty diff is silently tolerated.
  git add .nubos-pilot/roadmap.yaml .nubos-pilot/ROADMAP.md
  if ! git diff --cached --quiet; then
    # Choose the verb from mode: append vs insert.
    VERB="append"
    if [[ "$(echo "$INIT" | jq -r '.insertAfter')" != "null" ]]; then
      VERB="insert"
    fi
    git commit --no-verify -m "docs(05-05): plan-milestone-gaps ${VERB} phase(s)"
  fi
else
  echo "commit_docs=false — skipping roadmap commit (roadmap.yaml/ROADMAP.md remain staged-dirty)" >&2
fi
```

## Naming Conventions (D-03)

Canonical tokens this workflow uses:

| Token                                 | Value                          |
| ------------------------------------- | ------------------------------ |
| Tools-binary                          | `np-tools.cjs`                 |
| Slash-command                         | `/np:plan-milestone-gaps`      |
| Roadmap file path                     | `.nubos-pilot/ROADMAP.md`      |

Auto-advance state lives on `workflow.auto_advance` (boolean). Set
from `/np:autonomous`; cleared when the loop exits or the user aborts.

## Exit Codes

- `0` — applied successfully, or user aborted with nothing to do.
- non-zero — unrecoverable error (invalid audit path, YAML parse failure,
  duplicate slug on re-run). Error code + message are emitted on stderr in
  JSON `{error: {code, message, details}}` form by `np-tools.cjs`.

## See Also

- `lib/gaps.cjs` — scan, parse, group-to-phase logic (pure, unit-tested).
- `lib/roadmap.cjs` — write API (`addMilestone`, `addPhase`,
  `insertPhaseAfter`).
- Phase 05 RESEARCH § "Pitfall 5" — why `depends_on` must be semantic.
- `/np:next` — dispatches to this workflow when the project state flags
  uncovered gaps.
