---
command: np:discuss-phase
description: Adaptive interview to capture milestone implementation decisions; writes M<NNN>-CONTEXT.md.
argument-hint: <milestone-number> [--assumptions|--power]
---

# np:discuss-phase

Extract implementation decisions for a milestone (user-facing: "phase") that downstream agents (researcher, planner) need. Writes `.nubos-pilot/milestones/M<NNN>/M<NNN>-CONTEXT.md`.

The `--assumptions` flag routes to `workflows/discuss-phase-assumptions.md`
(lighter-weight codebase-first mode). The `--power` flag is owned by Plan
05-08 and is not implemented here.

**Scope note (Phase 5):** No advisor subagent spawn, no `--batch`, no
`--analyze`, no `--chain` auto-advance. Those are deferred; this
workflow delivers PLAN-01 and nothing beyond it.

## Initialize

```bash
INIT=$(node .nubos-pilot/bin/np-tools.cjs init discuss-phase "$PHASE")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
```

Parse JSON for: `milestone`, `milestone_id`, `milestone_dir`, `milestone_name`,
`milestone_context_path`, `has_context`, `has_milestone_dir`, `goal`,
`requirements`, `agent_skills`, `mode`.

If the user passed `--assumptions`, route to
`workflows/discuss-phase-assumptions.md` and exit this workflow.

## Purpose

<purpose>
Extract implementation decisions that downstream agents need. Analyze the
phase to identify gray areas, let the user choose what to discuss, then
deep-dive each selected area until satisfied.

You are a thinking partner, not an interviewer. The user is the visionary —
you are the builder. Your job is to capture decisions that will guide
research and planning, not to figure out implementation yourself.
</purpose>

## Downstream Awareness

<downstream_awareness>
**CONTEXT.md feeds into:**

1. **researcher** — Reads CONTEXT.md to know WHAT to research
   - "User wants card-based layout" → researcher investigates card component patterns
   - "Infinite scroll decided" → researcher looks into virtualization libraries

2. **planner** — Reads CONTEXT.md to know WHAT decisions are locked
   - "Pull-to-refresh on mobile" → planner includes that in task specs
   - "Claude's Discretion: loading skeleton" → planner can decide approach

**Your job:** Capture decisions clearly enough that downstream agents can act
on them without asking the user again.

**Not your job:** Figure out HOW to implement. That's what research and
planning do with the decisions you capture.
</downstream_awareness>

## Philosophy

<philosophy>
**User = founder/visionary. Claude = builder.**

The user knows:
- How they imagine it working
- What it should look/feel like
- What's essential vs nice-to-have
- Specific behaviors or references they have in mind

The user doesn't know (and shouldn't be asked):
- Codebase patterns (researcher reads the code)
- Technical risks (researcher identifies these)
- Implementation approach (planner figures this out)
- Success metrics (inferred from the work)

Ask about vision and implementation choices. Capture decisions for downstream
agents.
</philosophy>

## Scope Guardrail

<scope_guardrail>
**CRITICAL: No scope creep.**

The phase boundary comes from ROADMAP.md and is FIXED. Discussion clarifies
HOW to implement what's scoped, never WHETHER to add new capabilities.

**Allowed (clarifying ambiguity):**
- "How should posts be displayed?" (layout, density, info shown)
- "What happens on empty state?" (within the feature)
- "Pull to refresh or manual?" (behavior choice)

**Not allowed (scope creep):**
- "Should we also add comments?" (new capability)
- "What about search/filtering?" (new capability)
- "Maybe include bookmarking?" (new capability)

**The heuristic:** Does this clarify how we implement what's already in the
phase, or does it add a new capability that could be its own phase?

**When user suggests scope creep:**
```
"[Feature X] would be a new capability — that's its own phase.
Want me to note it for the roadmap backlog?

For now, let's focus on [phase domain]."
```

Capture the idea in a "Deferred Ideas" section. Don't lose it, don't act on it.
</scope_guardrail>

## Answer Validation

<answer_validation>
**IMPORTANT: Answer validation** — After every interactive prompt, check if the
response is empty or whitespace-only. If so:
1. Retry the question once with the same parameters
2. If still empty, present the options as a plain-text numbered list and ask
   the user to type their choice number
Never proceed with an empty answer.

**Text mode (`workflow.text_mode: true` in config or `--text` flag):**
When text mode is active, **do not use `np-tools.cjs askuser` at all**.
Instead, present every question as a plain-text numbered list and ask the
user to type their choice number. This is required for Claude Code remote
sessions (`/rc` mode) where the Claude App cannot forward TUI menu selections
back to the host.

Enable text mode:
- Per-session: pass `--text` flag
- Per-project: `np-tools.cjs config-set workflow.text_mode true`

Text mode applies to ALL workflows in the session, not just discuss-phase.
</answer_validation>

## Process

### Step 1: Guard against existing M<NNN>-CONTEXT.md

If `has_context` is `true`, ask the user how to proceed:

```bash
node .nubos-pilot/bin/np-tools.cjs askuser --json '{
  "type": "select",
  "prompt": "Milestone '"$MILESTONE_ID"' already has a CONTEXT.md. What do you want to do?",
  "options": [
    "Overwrite existing CONTEXT.md",
    "Append update section",
    "Abort"
  ]
}'
```

- **Overwrite** → preserve the prior file as `<milestone_id>-CONTEXT.archive.md`
  before writing the new one:
  ```bash
  mv "$MILESTONE_DIR/$MILESTONE_ID-CONTEXT.md" "$MILESTONE_DIR/$MILESTONE_ID-CONTEXT.archive.md"
  ```
- **Append update section** → skip the archive move; the write step below
  appends a fresh `## Update — <date>` section instead of replacing content.
- **Abort** → exit the workflow. No file changes.

If `has_context` is `false`, ensure the milestone dir exists before writing later:

```bash
if [ "$HAS_MILESTONE_DIR" = "false" ]; then
  mkdir -p "$MILESTONE_DIR"
  mkdir -p "$MILESTONE_DIR/slices"
fi
```

Continue directly to Step 2.

### Step 2: Confirm phase goal

Read `goal` and `requirements` from INIT. Confirm the phase goal is what the
user expects (users sometimes discover the roadmap goal is stale before
discussion starts):

```bash
node .nubos-pilot/bin/np-tools.cjs askuser --json '{
  "type": "confirm",
  "prompt": "ROADMAP goal for phase '"$PHASE"': \"'"$GOAL"'\". Still accurate?",
  "default": true
}'
```

If the user says `no`, capture the refined goal with a free-text input call
and record it for the `<domain>` section of CONTEXT.md:

```bash
node .nubos-pilot/bin/np-tools.cjs askuser --json '{
  "type": "input",
  "prompt": "Refined goal for phase '"$PHASE"':"
}'
```

### Step 3: Present phase-specific gray areas

Based on the phase goal + domain, generate 3–4 concrete gray areas (not
generic UI/UX labels — specific decisions like "Session handling", "Error
responses", "Multi-device policy"). Present them via a multi-select:

```bash
node .nubos-pilot/bin/np-tools.cjs askuser --json '{
  "type": "multiselect",
  "prompt": "Which areas do you want to discuss for '"$PHASE_NAME"'?",
  "options": [
    "<area 1>",
    "<area 2>",
    "<area 3>",
    "<area 4>"
  ]
}'
```

Per the scope-guardrail block above: options must clarify HOW to build what
is in scope — never introduce new capabilities.

### Step 4: Discuss each selected area

For each selected area, ask 2–4 focused questions. Every prompt routes
through `np-tools.cjs askuser` — never through the runtime-native structured
question tool directly (SC-5 enforcement from Phase 3).

Per area, the recommended flow is:

```bash
# Decision question (typed as select when options exist)
node .nubos-pilot/bin/np-tools.cjs askuser --json '{
  "type": "select",
  "prompt": "For <area>: <specific decision>?",
  "options": ["<choice A>", "<choice B>", "<choice C>"]
}'

# Follow-up free-text capture when the user picks "Other" or needs nuance
node .nubos-pilot/bin/np-tools.cjs askuser --json '{
  "type": "input",
  "prompt": "Anything specific about <area> downstream agents must know?"
}'

# Continuation gate
node .nubos-pilot/bin/np-tools.cjs askuser --json '{
  "type": "select",
  "prompt": "More questions about <area>, or move on?",
  "options": ["More questions", "Next area"]
}'
```

After all selected areas are covered:

```bash
node .nubos-pilot/bin/np-tools.cjs askuser --json '{
  "type": "select",
  "prompt": "We have discussed <areas>. Anything else before we write CONTEXT.md?",
  "options": ["Explore more gray areas", "I am ready for CONTEXT.md"]
}'
```

If the user chooses to explore more, loop back to Step 3 with 2–4 fresh
candidate areas. Otherwise proceed to Step 5.

**Canonical ref accumulation.** When the user references a doc/ADR/spec
during any answer ("read adr-014", "per browse-spec.md"), read it and add
its full relative path to the canonical-refs accumulator — these are the
most important refs because they come straight from the user.

### Step 5: Capture remaining CONTEXT.md sections

Collect short free-text inputs for the remaining required sections before
rendering:

```bash
node .nubos-pilot/bin/np-tools.cjs askuser --json '{
  "type": "input",
  "prompt": "Canonical refs (paths to ADRs/specs/docs downstream agents must read) — comma separated or \"none\":"
}'
```

```bash
node .nubos-pilot/bin/np-tools.cjs askuser --json '{
  "type": "input",
  "prompt": "Reusable code / existing assets relevant to this phase — or \"none\":"
}'
```

```bash
node .nubos-pilot/bin/np-tools.cjs askuser --json '{
  "type": "input",
  "prompt": "Specific references (\"I want it like X\" moments) — or \"none\":"
}'
```

```bash
node .nubos-pilot/bin/np-tools.cjs askuser --json '{
  "type": "input",
  "prompt": "Deferred ideas (things we noted but belong in later phases) — or \"none\":"
}'
```

```bash
node .nubos-pilot/bin/np-tools.cjs askuser --json '{
  "type": "input",
  "prompt": "Claude\u2019s Discretion — areas where you want Claude to decide without asking:"
}'
```

### Step 6: Render M<NNN>-CONTEXT.md

Render `templates/milestone/CONTEXT.md` with `lib/template.cjs`. The render call is
fail-loud on unknown placeholders, so the variables object below must match
the template's `{{var}}` keys exactly.

```bash
MILESTONE_DIR=$(echo "$INIT" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{console.log(JSON.parse(d).milestone_dir)})')
MILESTONE_ID=$(echo "$INIT" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{console.log(JSON.parse(d).milestone_id)})')
CONTEXT_PATH=$(echo "$INIT" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{console.log(JSON.parse(d).milestone_context_path)})')
mkdir -p "$MILESTONE_DIR"
mkdir -p "$MILESTONE_DIR/slices"

node -e '
  const { render } = require("./lib/template.cjs");
  const fs = require("node:fs");
  const tpl = fs.readFileSync("templates/milestone/CONTEXT.md", "utf-8");
  const vars = JSON.parse(process.argv[1]);
  process.stdout.write(render(tpl, vars));
' "$VARS_JSON" > "$CONTEXT_PATH"
```

`$VARS_JSON` is the JSON-serialised accumulator from Steps 2–5 (keys map to
`templates/milestone/CONTEXT.md` placeholders):

```jsonc
{
  "milestone_id": "M001",
  "milestone_name": "Auth & Basic UI",
  "created_date": "2026-04-15",
  "goal_text": "...",
  "domain_text": "...",
  "decisions_text": "...",     // collected from Step 4
  "canonical_refs_text": "...",
  "deferred_text": "..."
}
```

If the template lacks a key, `render()` throws
`NubosPilotError('template-missing-key', …)` — the workflow must not swallow
that error. Fix the template or the accumulator, don't mask the failure.

### Step 7: Commit respecting config.commit_docs

```bash
COMMIT_DOCS=$(node .nubos-pilot/bin/np-tools.cjs config-get workflow.commit_docs 2>/dev/null || echo "true")
if [[ "$COMMIT_DOCS" == "true" ]]; then
  git add "$CONTEXT_PATH"
  git commit -m "docs($MILESTONE_ID): capture milestone context"
fi
```

If `workflow.commit_docs` is false, leave the file uncommitted — the user is
opting into manual commit gating.

### Step 8: Confirm and next steps

```bash
node .nubos-pilot/bin/np-tools.cjs askuser --json '{
  "type": "confirm",
  "prompt": "CONTEXT.md written at '"$CONTEXT_PATH"'. Run np:plan-phase '"$PHASE"' now?",
  "default": true
}'
```

Yes → invoke `np:plan-phase $PHASE` via the runtime's standard workflow
dispatcher. No → print the manual next-step hint:

```
Next: /np:plan-phase $PHASE
```

## Success Criteria

- `{milestone_dir}/{milestone_id}-CONTEXT.md` exists with all six required sections
  (domain, decisions, canonical_refs, code_context, specifics, deferred).
- Every interactive prompt went through `np-tools.cjs askuser`; zero bare
  `np-tools.cjs askuser` bypasses.
- If prior CONTEXT.md existed, user explicitly chose overwrite / append /
  abort — no silent overwrite.
- Deferred ideas preserved verbatim for future phases.
- Commit (if `workflow.commit_docs=true`) landed via
  `docs(PADDED): capture phase context`.
