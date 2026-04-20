---
command: np:new-milestone
description: Append a milestone (M<NNN>) to an initialized project. Creates .nubos-pilot/milestones/M<NNN>/ with CONTEXT.md, ROADMAP.md, META.json. Never rewrites PROJECT.md (D-29).
argument-hint: [--apply <answers.json>]
---

# np:new-milestone

Append a new milestone to an already-initialized project in nubos-pilot milestone layout. This workflow is the counterpart to `np:new-project`: `new-project` creates the root; `new-milestone` grows it.

A milestone is a **scope anchor** that ships as a unit. It contains slices (execution waves) that contain tasks (atomic executor units). This workflow seeds the milestone shell only — slices and tasks are planned later via `/np:plan-phase <N>`.

## Philosophy

<philosophy>
A milestone is a scope anchor — the unit that ships together and earns a retrospective. Adding a milestone is never a rewrite of prior work: previous milestones' slices, tasks, and SUMMARY files stay exactly as they were. Only `roadmap.yaml`, `.nubos-pilot/milestones/M<NNN>/` (new), and optionally `REQUIREMENTS.md` grow. PROJECT.md is sacrosanct — see D-29.
</philosophy>

## Scope Guardrail

<scope_guardrail>
This workflow ONLY touches:

- `.nubos-pilot/roadmap.yaml` (append milestone with empty `slices: []`)
- `.nubos-pilot/ROADMAP.md` (regenerated via lib/roadmap-render)
- `.nubos-pilot/STATE.md` (advance milestone pointers)
- `.nubos-pilot/milestones/M<NNN>/` (new directory with CONTEXT/ROADMAP/META artefacts + empty `slices/` subdir)
- `.nubos-pilot/REQUIREMENTS.md` (APPEND a new H2 section ONLY when `create_req_prefix` is `true`)

It NEVER writes `.nubos-pilot/PROJECT.md` — D-29 strict invariant. The subcommand has a defensive guard (`_writeFile`) that throws `new-milestone-forbidden-write` if any code path ever routes a PROJECT.md target to it.
</scope_guardrail>

## Downstream Awareness

<downstream_awareness>
Milestone IDs are auto-generated as `M<NNN>` where N is the next integer after the highest existing milestone number in `roadmap.yaml`. The milestone directory `.nubos-pilot/milestones/M<NNN>/` is keyed by this integer. Slices inside a milestone are numbered per-milestone (S001, S002, ...) and created later by `/np:plan-phase <N>`.
</downstream_awareness>

## Guard

Refuse early when not in an initialized project.

```bash
if [ ! -f .nubos-pilot/PROJECT.md ]; then
  echo "Error: no .nubos-pilot/PROJECT.md found. Run np:new-project first."
  exit 1
fi
```

The subcommand raises `project-not-initialized` anyway, but the shell check gives a cleaner message before the interview starts.

## Single-Call Init

```bash
INIT=$(node .nubos-pilot/bin/np-tools.cjs init new-milestone)
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
```

Payload: three questions — `milestone_name`, `milestone_goal`, `create_req_prefix` (confirm).

## Interview

Three questions through `np-tools.cjs askuser`. No runtime-native question tool is permitted anywhere in this file.

```bash
ANS_MS_NAME=$(node .nubos-pilot/bin/np-tools.cjs askuser --json '{"type":"input","prompt":"Milestone name (e.g. Auth & Basic UI)?"}')
ANS_MS_GOAL=$(node .nubos-pilot/bin/np-tools.cjs askuser --json '{"type":"input","prompt":"Milestone goal (one sentence)?"}')
ANS_REQ_PREFIX=$(node .nubos-pilot/bin/np-tools.cjs askuser --json '{"type":"confirm","prompt":"Create a new Requirements section for this milestone?","default":false}')
```

<answer_validation>
The subcommand auto-numbers the milestone as the next `M<NNN>` after the highest existing milestone. Empty milestone name throws `answers-missing-field`. Roadmap YAML parse errors surface as `roadmap-parse-error`.
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
    create_req_prefix: prefix === "true" || prefix === "yes" || prefix === "y",
  };
  fs.writeFileSync(process.env.ANSWERS, JSON.stringify(payload));
' ANS_MS_NAME="$ANS_MS_NAME" ANS_MS_GOAL="$ANS_MS_GOAL" ANS_REQ_PREFIX="$ANS_REQ_PREFIX" ANSWERS="$ANSWERS"

node .nubos-pilot/bin/np-tools.cjs init new-milestone --apply "$ANSWERS"
```

On success the subcommand emits:

```json
{
  "mode": "apply",
  "milestone_id": "M002",
  "milestone_number": 2,
  "milestone_name": "Profile & Settings",
  "milestone_dir": "<abs path>/.nubos-pilot/milestones/M002",
  "created_req_prefix": true
}
```

## D-29 Invariant

<!--
Defense-in-depth: the subcommand already refuses to write PROJECT.md via
_writeFile(). NEVER add a step here that reads, appends to, or rewrites
PROJECT.md. If a future change needs to "also update PROJECT.md", it
belongs in a separate workflow that the user invokes explicitly.
-->

## Optional Commit

```bash
if [ "$(node .nubos-pilot/bin/np-tools.cjs config-get workflow.commit_docs 2>/dev/null)" = "true" ]; then
  git add .nubos-pilot/
  git commit -m "chore: np:new-milestone add $ANS_MS_NAME"
fi
```

## Output

```
np:new-milestone complete.

Appended milestone: <milestone_name> (id=M<NNN>)
Milestone dir: .nubos-pilot/milestones/M<NNN>/

Next: run `np:discuss-phase <N>` to gather context, then
`np:plan-phase <N>` to break the milestone into slices + tasks.
```

## Errors

| Code | Trigger | User action |
|------|---------|-------------|
| `project-not-initialized` | no `PROJECT.md` in `.nubos-pilot/` | Run `np:new-project` first |
| `answers-missing-field` | required field empty/missing | Re-run; answer all prompts |
| `roadmap-parse-error` | roadmap.yaml corrupt | Inspect and fix `.nubos-pilot/roadmap.yaml` |
| `new-milestone-forbidden-write` | internal safeguard tripped | File a bug — should never surface |
