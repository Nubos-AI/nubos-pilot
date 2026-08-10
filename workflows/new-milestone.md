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
LANG_DIRECTIVE=$(node .nubos-pilot/bin/np-tools.cjs lang-directive)
INIT=$(node .nubos-pilot/bin/np-tools.cjs init new-milestone)
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
```

**Language (SSOT = `.nubos-pilot/config.json` → `response_language`).**
`$LANG_DIRECTIVE` is authoritative. Obey it for askuser prompt texts,
user-facing output, and any prose written into milestone artefacts (YAML
keys, IDs, and identifiers stay canonical English). Supersedes CLAUDE.md.

**Askuser routing.** Every `node .nubos-pilot/bin/np-tools.cjs askuser …` block below is a spec, not a literal command. Pick the path once at Initialize:
- **Claude Code** (native `AskUserQuestion` tool is available): parse the JSON spec and call `AskUserQuestion` directly. `select` → `multiSelect: false`; `multiselect` → `multiSelect: true`; `confirm` → `options: [{label: "Yes"}, {label: "No"}]`; `input` → ask free-form in chat. Use a short `header` (≤12 chars).
- **`text_mode == true`** (INIT payload): skip every askuser block and render questions as plain-text numbered lists. Opt-in via `.nubos-pilot/config.json` → `workflow.text_mode`.
- **Other runtime with TTY** (Codex, Gemini, …): execute the shell `askuser` block verbatim.

Payload: four questions — `milestone_name`, `milestone_goal`, `requirements`, `create_req_prefix` (confirm).

## Interview

Four questions through `np-tools.cjs askuser`. No runtime-native question tool is permitted anywhere in this file.

Run `node .nubos-pilot/bin/np-tools.cjs init new-milestone` with no flags first and read the emitted `questions[]` — the `requirements` question text is generated and already lists the requirement IDs no milestone has claimed yet. Use that text verbatim; do not hand-write the question, or the user loses the list.

```bash
ANS_MS_NAME=$(node .nubos-pilot/bin/np-tools.cjs askuser --json '{"type":"input","question":"Milestone name (e.g. Auth & Basic UI)?"}')
ANS_MS_GOAL=$(node .nubos-pilot/bin/np-tools.cjs askuser --json '{"type":"input","question":"Milestone goal (one sentence)?"}')
ANS_REQS=$(node .nubos-pilot/bin/np-tools.cjs askuser --json "{\"type\":\"input\",\"question\":$REQ_QUESTION_JSON}")
ANS_REQ_PREFIX=$(node .nubos-pilot/bin/np-tools.cjs askuser --json '{"type":"confirm","question":"Create a new Requirements section for this milestone?","default":false}')
```

<answer_validation>
The subcommand auto-numbers the milestone as the next `M<NNN>` after the highest existing milestone. Empty milestone name throws `answers-missing-field`. Roadmap YAML parse errors surface as `roadmap-parse-error`.

`requirements` accepts a comma-separated list of IDs that must already exist in `REQUIREMENTS.md`. An unknown ID throws `requirements-id-unknown`, a malformed one `requirements-id-malformed`, and the `REQ-TBD` placeholder `requirements-id-placeholder` — all **before** the milestone is created, so a rejected answer leaves `roadmap.yaml` untouched. An empty answer is allowed and writes `requirements: []`.

**Do not paper over an empty answer.** `requirements: []` is what makes `/np:validate-phase` audit zero requirements — surface that to the user when they skip it, and point them at `update-phase-meta` to fill it in later:
`node .nubos-pilot/bin/np-tools.cjs update-phase-meta <N> --stdin <<< '{"requirements":["REQ-01"]}'`
`npx nubos-pilot doctor` reports `milestone-without-requirements` for exactly this state.
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
    requirements: process.env.ANS_REQS || "",
    create_req_prefix: prefix === "true" || prefix === "yes" || prefix === "y",
  };
  fs.writeFileSync(process.env.ANSWERS, JSON.stringify(payload));
' ANS_MS_NAME="$ANS_MS_NAME" ANS_MS_GOAL="$ANS_MS_GOAL" ANS_REQS="$ANS_REQS" ANS_REQ_PREFIX="$ANS_REQ_PREFIX" ANSWERS="$ANSWERS"

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
  "created_req_prefix": true,
  "requirements": ["REQ-04", "REQ-05"]
}
```

Report `requirements` back to the user. When it is `[]`, say so plainly and name the consequence — a Nyquist audit with no requirement to sample is not a passing audit, it is an empty one.

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
## Definition of Done

This workflow exits successfully only when, per [`templates/COMPLETENESS.md`](../templates/COMPLETENESS.md):

- Rule 1 (Do the whole thing) — milestone shell contains every required artifact (`M<NNN>-CONTEXT.md`, `M<NNN>-ROADMAP.md`, `M<NNN>-META.json`, `slices/`).
- Rule 11 (Ship the complete thing) — milestone is plannable on exit; `np:plan-phase` runs without prep.

Any violation = workflow exits non-zero. The orchestrator does not relax these.
