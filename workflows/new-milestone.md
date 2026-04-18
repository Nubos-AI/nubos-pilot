---
command: np:new-milestone
description: Append a milestone + first phase to an initialized project. Never rewrites PROJECT.md (D-29).
---

# np:new-milestone

Append a new milestone and its first phase to an already-initialized
project. This workflow is the counterpart to `np:new-project`: `new-project`
creates the root; `new-milestone` grows it.

## Philosophy

<philosophy>
A milestone is a scope anchor — the unit that ships together and earns a
retrospective. Adding a milestone is never a rewrite of prior work: the
previous milestone's phases, plans, and SUMMARY.md files stay exactly as
they were. Only `roadmap.yaml` and (optionally) `REQUIREMENTS.md` grow.
PROJECT.md is sacrosanct — see D-29.
</philosophy>

## Scope Guardrail

<scope_guardrail>
This workflow ONLY touches:

- `.nubos-pilot/roadmap.yaml` (append milestone + first phase)
- `.nubos-pilot/ROADMAP.md` (regenerated via lib/roadmap-render)
- `.nubos-pilot/STATE.md` (advance milestone + current_phase pointers)
- `.nubos-pilot/phases/<NN>-<slug>/` (new phase directory +
  `<NN>-CONTEXT.md` placeholder)
- `.nubos-pilot/REQUIREMENTS.md` (APPEND a new H2 section ONLY when
  `create_req_prefix` is `true`)

It NEVER writes `.nubos-pilot/PROJECT.md` — D-29 strict invariant. The
subcommand has a defensive guard (`_writeFile`) that throws
`new-milestone-forbidden-write` if any code path ever routes a PROJECT.md
target to it.
</scope_guardrail>

## Downstream Awareness

<downstream_awareness>
Phase numbers are global across the roadmap — a phase dir at
`.nubos-pilot/phases/<NN>-<slug>/` is keyed by the integer `NN`. The
subcommand computes the next global number across all milestones before
seeding the new milestone; this avoids the per-milestone numbering in
`lib/roadmap.cjs addPhase` (Phase 05-05) which would collide with phase
1 of the previous milestone on disk.
</downstream_awareness>

## Guard

Refuse early when not in an initialized project.

```bash
if [ ! -f .nubos-pilot/PROJECT.md ]; then
  echo "Error: no .nubos-pilot/PROJECT.md found. Run np:new-project first."
  exit 1
fi
```

The subcommand raises `project-not-initialized` anyway, but the shell
check gives a cleaner message before the interview starts.

## Single-Call Init

```bash
INIT=$(node np-tools.cjs init new-milestone)
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
```

Payload: four questions — `milestone_name`, `milestone_goal`,
`first_phase_name`, `create_req_prefix` (confirm).

## Interview

Four questions through `np-tools.cjs askuser`. No runtime-native
question tool is permitted anywhere in this file.

```bash
ANS_MS_NAME=$(node np-tools.cjs askuser --json '{"type":"input","prompt":"Milestone name (e.g. v2.0)?"}')
ANS_MS_GOAL=$(node np-tools.cjs askuser --json '{"type":"input","prompt":"Milestone goal (one sentence)?"}')
ANS_FIRST_PHASE=$(node np-tools.cjs askuser --json '{"type":"input","prompt":"First phase name for this milestone?"}')
ANS_REQ_PREFIX=$(node np-tools.cjs askuser --json '{"type":"confirm","prompt":"Create a new Requirements section for this milestone?","default":false}')
```

<answer_validation>
The subcommand slugifies `milestone_name` and `first_phase_name`; empty
results throw `invalid-slug`. Duplicate milestone ids (after slugify)
throw `roadmap-duplicate-milestone` and this workflow prints the error
and exits — the user decides whether to pick a different name.
</answer_validation>

## Apply

```bash
ANSWERS=$(mktemp -t np-new-milestone-answers.XXXXXX)
trap 'rm -f "$ANSWERS"' EXIT

node -e '
  const fs = require("fs");
  const prefix = process.env.ANS_REQ_PREFIX;
  const payload = {
    milestone_name: process.env.ANS_MS_NAME,
    milestone_goal: process.env.ANS_MS_GOAL,
    first_phase_name: process.env.ANS_FIRST_PHASE,
    create_req_prefix: prefix === "true" || prefix === "yes" || prefix === "y",
  };
  fs.writeFileSync(process.env.ANSWERS, JSON.stringify(payload));
' ANS_MS_NAME="$ANS_MS_NAME" ANS_MS_GOAL="$ANS_MS_GOAL" ANS_FIRST_PHASE="$ANS_FIRST_PHASE" ANS_REQ_PREFIX="$ANS_REQ_PREFIX" ANSWERS="$ANSWERS"

node np-tools.cjs init new-milestone --apply "$ANSWERS"
```

On success the subcommand emits:

```json
{
  "mode": "apply",
  "milestoneId": "v2-0",
  "phaseNumber": 11,
  "phaseSlug": "second-phase",
  "created_req_prefix": true
}
```

## D-29 Invariant

<!--
Defense-in-depth: the subcommand already refuses to write PROJECT.md via
_writeFile(). This comment is a reminder for humans reviewing this
workflow: NEVER add a step here that reads, appends to, or rewrites
PROJECT.md. If a future change needs to "also update PROJECT.md", it
belongs in a separate workflow that the user invokes explicitly.
-->

## Optional Commit

```bash
if [ "$(node np-tools.cjs config-get workflow.commit_docs 2>/dev/null)" = "true" ]; then
  git add .nubos-pilot/
  git commit -m "chore: np:new-milestone add $ANS_MS_NAME"
fi
```

## Output

```
np:new-milestone complete.

Appended milestone: <milestone_name> (id=<slug>)
First phase: <NN>-<slug>

Next: run `np:next` to see the newly-current phase, or start
`np:discuss-phase <NN>` to gather context for it.
```

## Errors

| Code | Trigger | User action |
|------|---------|-------------|
| `project-not-initialized` | no `PROJECT.md` in `.nubos-pilot/` | Run `np:new-project` first |
| `roadmap-duplicate-milestone` | milestone id (slugified name) already exists | Pick a different name |
| `invalid-slug` | milestone/phase name has no `[a-z0-9]` content | Pick a different name |
| `new-milestone-forbidden-write` | internal safeguard tripped | File a bug — should never surface |
