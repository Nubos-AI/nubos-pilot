---
command: np:discuss-phase --assumptions
description: Codebase-first assumption surfacing; writes {padded}-ASSUMPTIONS.md (not CONTEXT.md).
---

# np:discuss-phase --assumptions

> **Phase-5 scope note:** Assumptions analysis runs as inline orchestrator
> reasoning. A dedicated `assumptions-analyzer` subagent is deferred
> (tracked in `.planning/phases/05-planning-workflows-agents/05-CONTEXT.md`
> §deferred). A standalone `assumptions-analyzer` agent is intentionally
> out of scope in Phase 5 — the orchestrator LLM performs the analysis
> directly inside this workflow.

> **Artifact note:** This mode writes `{phase_dir}/{padded}-ASSUMPTIONS.md`,
> NOT `{padded}-CONTEXT.md`. It deliberately produces a separate artifact so
> running `--assumptions` never clobbers a CONTEXT.md written by the
> interactive adaptive mode. Downstream agents (researcher, planner) can
> read either file; the planner precedence rule is "CONTEXT.md wins if both
> exist".

## Initialize

```bash
INIT=$(node np-tools.cjs init discuss-phase "$PHASE" --assumptions)
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
```

Parse JSON for: `phase_number`, `padded`, `phase_dir`, `phase_name`,
`phase_slug`, `has_context`, `goal`, `requirements`, `agent_skills`, `mode`
(expected `"assumptions"`).

## Purpose

<purpose>
Extract implementation decisions that downstream agents need — using
codebase-first analysis and assumption surfacing instead of interview-style
questioning.

You are a thinking partner, not an interviewer. Analyze the codebase deeply,
surface what you believe based on evidence, and ask the user only to correct
what's wrong.
</purpose>

## Downstream Awareness

<downstream_awareness>
**ASSUMPTIONS.md feeds into:**

1. **researcher** — Reads ASSUMPTIONS.md to know WHAT to research.
2. **planner** — Reads ASSUMPTIONS.md to know WHAT decisions are locked.

**Your job:** Capture decisions clearly enough that downstream agents can
act on them without asking the user again. Output shape is identical to
adaptive-mode CONTEXT.md — six sections (domain, decisions, canonical_refs,
code_context, specifics, deferred) — only the filename differs.
</downstream_awareness>

## Philosophy

<philosophy>
**Assumptions mode philosophy:**

The user is a visionary, not a codebase archaeologist. They need enough
context to evaluate whether your assumptions match their intent — not to
answer questions you could figure out by reading the code.

- Read the codebase FIRST, form opinions SECOND, ask ONLY about what's
  genuinely unclear
- Every assumption must cite evidence (file paths, patterns found)
- Every assumption must state consequences if wrong
- Minimize user interactions: ~2-4 corrections vs ~15-20 questions
</philosophy>

## Scope Guardrail

<scope_guardrail>
**CRITICAL: No scope creep.**

The phase boundary comes from ROADMAP.md and is FIXED. Discussion clarifies
HOW to implement what's scoped, never WHETHER to add new capabilities.

When user suggests scope creep:
"[Feature X] would be a new capability — that's its own phase.
Want me to note it for the roadmap backlog? For now, let's focus on
[phase domain]."

Capture the idea in "Deferred Ideas". Don't lose it, don't act on it.
</scope_guardrail>

## Answer Validation

<answer_validation>
**IMPORTANT: Answer validation** — After every interactive prompt, check if
the response is empty or whitespace-only. If so:
1. Retry the question once with the same parameters
2. If still empty, present the options as a plain-text numbered list

**Text mode (`workflow.text_mode: true` in config or `--text` flag):**
When text mode is active, do not use `np-tools.cjs askuser` at all. Present
every question as a plain-text numbered list and ask the user to type their
choice number.
</answer_validation>

## Process

### Step 1: Guard against existing ASSUMPTIONS.md

If an ASSUMPTIONS.md already exists at `{phase_dir}/{padded}-ASSUMPTIONS.md`,
ask the user explicitly:

```bash
ASSUMPTIONS_PATH="$PHASE_DIR/$PADDED-ASSUMPTIONS.md"
if [[ -f "$ASSUMPTIONS_PATH" ]]; then
  node np-tools.cjs askuser --json '{
    "type": "select",
    "prompt": "Phase '"$PHASE"' already has ASSUMPTIONS.md. What do you want to do?",
    "options": [
      "Overwrite existing ASSUMPTIONS.md",
      "Abort"
    ]
  }'
fi
```

**Overwrite:** preserve the prior file under
`{padded}-ASSUMPTIONS.archive.md` before writing.
**Abort:** exit the workflow.

Note: we do NOT gate on `has_context` — CONTEXT.md lives in its own slot and
is untouched by this workflow.

### Step 2: Read the codebase and prior phases

Orchestrator responsibility (no bash wrapping needed — this is LLM work
driven by the standard Read/Glob/Grep tools):

1. Read `.planning/PROJECT.md`, `.planning/REQUIREMENTS.md`,
   `.planning/ROADMAP.md` for the current phase's boundary.
2. Read every prior `*-CONTEXT.md` / `*-ASSUMPTIONS.md` file with phase
   number < current. Capture locked decisions that constrain this phase.
3. Glob + Grep the codebase for artifacts touching the phase's domain
   (components, hooks, routes, API paths mentioned in the phase goal).
4. Extract: reusable assets, established patterns, integration points,
   existing tests that constrain refactors.

Accumulate findings internally; nothing is written yet.

### Step 3: Surface assumptions with evidence

For each implementation decision you are about to assume, write an
evidence-backed assumption of the form:

```
### A-<n>: <decision>
- **Assumption:** <what you intend to do>
- **Evidence:** <file:line or pattern observed>
- **Consequence if wrong:** <what breaks / has to be redone>
```

Produce 4–10 assumptions. Less than 4 means the codebase did not give you
enough signal — fall back to adaptive mode. More than 10 means you are
turning this into a questionnaire; consolidate.

### Step 4: Present assumptions for correction

Show the user the full list of assumptions (the orchestrator renders them
as a readable markdown list), then ask which ones are wrong:

```bash
node np-tools.cjs askuser --json '{
  "type": "multiselect",
  "prompt": "Which of these assumptions are wrong? (Select any that need correction; empty = all correct.)",
  "options": [
    "A-1: <short title>",
    "A-2: <short title>",
    "A-3: <short title>",
    "A-4: <short title>"
  ]
}'
```

For each selected (wrong) assumption, capture the user's correction:

```bash
node np-tools.cjs askuser --json '{
  "type": "input",
  "prompt": "A-<n> correction: what is the right decision, and why?"
}'
```

If the user selected zero assumptions to correct, skip directly to Step 6.

### Step 5: Confirm the corrected list

After applying corrections, show the user the revised assumption list and
confirm:

```bash
node np-tools.cjs askuser --json '{
  "type": "confirm",
  "prompt": "Corrected assumptions look right? (No = loop back for more corrections.)",
  "default": true
}'
```

No → return to Step 4 with the revised list as the new input. Max 2 loops
then force-proceed to Step 6 to prevent infinite correction cycles.

### Step 6: Render ASSUMPTIONS.md

Render the collected assumptions into the six-section CONTEXT.md-shaped
artifact. Use `lib/template.cjs render()` with the same
`templates/CONTEXT.md` template (section shapes are identical to adaptive
mode — only the output filename differs):

```bash
mkdir -p "$PHASE_DIR"
node -e '
  const { render } = require("./lib/template.cjs");
  const fs = require("node:fs");
  const tpl = fs.readFileSync("templates/CONTEXT.md", "utf-8");
  const vars = JSON.parse(process.argv[1]);
  process.stdout.write(render(tpl, vars));
' "$VARS_JSON" > "$PHASE_DIR/$PADDED-ASSUMPTIONS.md"
```

Variables mirror adaptive mode (phase_number, phase_name, goal, domain,
decisions, canonical_refs, code_context, specifics, deferred, date).
Decisions accumulator is populated from assumptions + user corrections.

`render()` is fail-loud on unknown placeholders — do not mask
`NubosPilotError('template-missing-key', …)` if it fires.

### Step 7: Commit respecting config.commit_docs

```bash
COMMIT_DOCS=$(node np-tools.cjs config-get workflow.commit_docs 2>/dev/null || echo "true")
if [[ "$COMMIT_DOCS" == "true" ]]; then
  git add "$PHASE_DIR/$PADDED-ASSUMPTIONS.md"
  git commit -m "docs($PADDED): capture phase assumptions"
fi
```

If `workflow.commit_docs` is false, leave the file uncommitted.

### Step 8: Confirm and next steps

```bash
node np-tools.cjs askuser --json '{
  "type": "confirm",
  "prompt": "ASSUMPTIONS.md written at '"$PHASE_DIR"'/'"$PADDED"'-ASSUMPTIONS.md. Run np:plan-phase '"$PHASE"' now?",
  "default": true
}'
```

Yes → hand off to `np:plan-phase $PHASE`. No → print
`Next: /np:plan-phase $PHASE` and exit.

## Success Criteria

- `{phase_dir}/{padded}-ASSUMPTIONS.md` exists with all six sections.
- No CONTEXT.md was touched by this workflow (distinct artifact).
- Every interactive prompt went through `np-tools.cjs askuser`; zero
  bypasses of the Phase-3 SC-5 invariant.
- Assumptions carried evidence citations (file paths or pattern refs) at
  the moment they were presented to the user.
- If ASSUMPTIONS.md existed before this run, user explicitly chose
  overwrite or abort — no silent overwrite.
