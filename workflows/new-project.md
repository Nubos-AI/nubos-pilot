---
command: np:new-project
description: Greenfield project scaffold — runs interactive interview, writes PROJECT.md + REQUIREMENTS.md + roadmap.yaml + first phase dir + ROADMAP.md.
---

# np:new-project

Initialize a new project through a short interview, then scaffold the five
baseline artifacts (`PROJECT.md`, `REQUIREMENTS.md`, `roadmap.yaml`,
`ROADMAP.md`, `STATE.md`) plus the first phase directory with a
`CONTEXT.md` placeholder. This is the greenfield entry point; all other
`np:*` workflows assume a project exists.

## Philosophy

<philosophy>
The most leveraged moment in any project is the first interview. Deep
questioning up front means better roadmaps, better plans, and better
executions. `np:new-project` does not try to be clever — it asks five
specific questions whose answers hard-constrain every downstream workflow,
writes the five files, and exits. The user can edit `PROJECT.md` and
`REQUIREMENTS.md` any time; this workflow's job is to produce a
well-formed scaffold, not to pretend to understand the project.
</philosophy>

## Scope Guardrail

<scope_guardrail>
This workflow ONLY touches `.nubos-pilot/` and creates its first phase
directory. It NEVER:

- runs outside the current working directory
- writes when `.nubos-pilot/PROJECT.md` already exists (D-28 Pitfall 8)
- mutates files in parent directories
- spawns agents or long-running tasks

If `.nubos-pilot/PROJECT.md` already exists, the subcommand throws
`project-already-initialized` and this workflow offers two paths: abort
or destructively reset (user must confirm destructively).
</scope_guardrail>

## Downstream Awareness

<downstream_awareness>
The five files this workflow writes are consumed by:

- `np:next` (reads `.nubos-pilot/STATE.md` + `.nubos-pilot/roadmap.yaml`)
- `np:discuss-phase` (reads `PROJECT.md` for constraints, writes
  `phases/01-<slug>/01-CONTEXT.md` which we scaffold as placeholder)
- `np:plan-phase` (reads `REQUIREMENTS.md` for requirement IDs)
- `np:progress` (reads `roadmap.yaml` for totals)

Downstream workflows expect `REQUIREMENTS.md` to have `REQ-*` IDs matching
the format `**REQ-NN**`. The template seeds `REQ-01` as a TBD — the user
is expected to edit it before running `np:plan-phase 1`.
</downstream_awareness>

## Single-Call Init

All context — the interview question set plus metadata — comes from a
single `np-tools.cjs init new-project` call.

```bash
INIT=$(node np-tools.cjs init new-project)
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
```

The payload shape:

```json
{
  "mode": "interview",
  "questions": [
    { "key": "project_name", "type": "input", "question": "Project name?" },
    { "key": "core_value", "type": "input", "question": "Core value — one sentence…" },
    { "key": "primary_constraints", "type": "input", "question": "Primary constraints…" },
    { "key": "first_milestone_name", "type": "input", "question": "First milestone name…" },
    { "key": "first_phase_name", "type": "input", "question": "First phase name…" }
  ]
}
```

## Interview

All five questions go through `np-tools.cjs askuser` (Phase 3 D-03). No
runtime-native question tool is permitted anywhere in this file — the
gateway subcommand is the single allowed path.

```bash
ANS_PROJECT_NAME=$(node np-tools.cjs askuser --json '{"type":"input","prompt":"Project name?"}')
ANS_CORE_VALUE=$(node np-tools.cjs askuser --json '{"type":"input","prompt":"Core value (1 sentence)?"}')
ANS_CONSTRAINTS=$(node np-tools.cjs askuser --json '{"type":"input","prompt":"Primary constraints (comma-separated)?"}')
ANS_FIRST_MS=$(node np-tools.cjs askuser --json '{"type":"input","prompt":"First milestone name?"}')
ANS_FIRST_PHASE=$(node np-tools.cjs askuser --json '{"type":"input","prompt":"First phase name?"}')
```

<answer_validation>
The subcommand slugifies `first_milestone_name` and `first_phase_name`
and throws `invalid-slug` if either produces an empty string after
stripping non-`[a-z0-9-]` characters. The user sees this error immediately
and can re-run the workflow with a different answer.

`project_name`, `core_value`, and `primary_constraints` are stored verbatim
inside the rendered templates — the subcommand's `render()` helper treats
them as plain strings, so shell metacharacters, Markdown syntax, and YAML
control chars are all inert. Task 2's NP-5 test asserts this.
</answer_validation>

## Apply

Write the five answers to a tmp JSON file and feed it to the subcommand.

```bash
ANSWERS=$(mktemp -t np-new-project-answers.XXXXXX)
trap 'rm -f "$ANSWERS"' EXIT

node -e '
  const fs = require("fs");
  const payload = {
    project_name: process.env.ANS_PROJECT_NAME,
    core_value: process.env.ANS_CORE_VALUE,
    primary_constraints: process.env.ANS_CONSTRAINTS,
    first_milestone_name: process.env.ANS_FIRST_MS,
    first_phase_name: process.env.ANS_FIRST_PHASE,
  };
  fs.writeFileSync(process.env.ANSWERS, JSON.stringify(payload));
' ANS_PROJECT_NAME="$ANS_PROJECT_NAME" ANS_CORE_VALUE="$ANS_CORE_VALUE" ANS_CONSTRAINTS="$ANS_CONSTRAINTS" ANS_FIRST_MS="$ANS_FIRST_MS" ANS_FIRST_PHASE="$ANS_FIRST_PHASE" ANSWERS="$ANSWERS"

node np-tools.cjs init new-project --apply "$ANSWERS"
```

We pass the answers via env → `node -e` → JSON file to keep shell
metacharacters inert (no heredoc interpolation). The subcommand emits
`{mode:"apply", milestoneId, firstPhaseNumber, firstPhaseSlug, created: [...]}`
on success.

## Re-Init Guard

When `PROJECT.md` already exists, the subcommand throws
`project-already-initialized`. The workflow catches it and offers a
decision:

```bash
set +e
node np-tools.cjs init new-project --apply "$ANSWERS"
APPLY_STATUS=$?
set -e

if [ "$APPLY_STATUS" -ne 0 ]; then
  CHOICE=$(node np-tools.cjs askuser --json '{
    "type": "select",
    "prompt": "Project already initialized. Choose:",
    "options": [
      "Abort (recommended)",
      "Delete existing .nubos-pilot/ and retry (destructive)"
    ]
  }')
  case "$CHOICE" in
    *destructive*|*Delete*)
      rm -rf ./.nubos-pilot
      node np-tools.cjs init new-project --apply "$ANSWERS"
      ;;
    *)
      exit 1
      ;;
  esac
fi
```

Default on ambiguity: abort. This workflow never deletes `.nubos-pilot/`
without an explicit `select` answer containing `Delete`.

## Optional Commit

When `config.commit_docs` is true, commit the scaffold. Use `execFileSync`
arg arrays (no shell-string concatenation) — see Phase 3 D-03 docs.

```bash
if [ "$(node np-tools.cjs config-get workflow.commit_docs 2>/dev/null)" = "true" ]; then
  git add .nubos-pilot/
  git commit -m "chore: np:new-project scaffold"
fi
```

## Output

On success, print a summary block and point the user at `np:next`:

```
np:new-project complete.

Created:
  .nubos-pilot/PROJECT.md
  .nubos-pilot/REQUIREMENTS.md
  .nubos-pilot/roadmap.yaml
  .nubos-pilot/ROADMAP.md
  .nubos-pilot/STATE.md
  .nubos-pilot/phases/01-<slug>/01-CONTEXT.md

Next: run `np:next` to resume, or edit REQUIREMENTS.md before discussing
the first phase with `np:discuss-phase 1`.
```

## Errors

| Code | Trigger | User action |
|------|---------|-------------|
| `project-already-initialized` | `PROJECT.md` exists | Abort or re-run with destructive option |
| `invalid-slug` | milestone/phase name has no `[a-z0-9]` content | Re-run with a different name |
| `answers-missing-field` | empty answer | Re-run and fill all 5 fields |

All errors propagate from the subcommand as `NubosPilotError` with a
stable `code` — workflow consumers can script against them.
