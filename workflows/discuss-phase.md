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
LANG_DIRECTIVE=$(node .nubos-pilot/bin/np-tools.cjs lang-directive)
INIT=$(node .nubos-pilot/bin/np-tools.cjs init discuss-phase "$PHASE")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
```

**Language (SSOT = `.nubos-pilot/config.json` → `response_language`).**
`$LANG_DIRECTIVE` is authoritative for this workflow. Obey it for ALL
subsequent output, askuser prompt texts, status updates, and the CONTEXT.md
rendering. This supersedes any directive in CLAUDE.md managed block if they
conflict — the config is the single source of truth.

Parse JSON for: `milestone`, `milestone_id`, `milestone_dir`, `milestone_name`,
`milestone_context_path`, `has_context`, `has_milestone_dir`, `goal`,
`requirements`, `agent_skills`, `mode`, `text_mode`, `text_mode_source`.

**Askuser routing (SSOT = INIT payload).** Every `node .nubos-pilot/bin/np-tools.cjs askuser …` block below is a **spec**, not a literal command. Pick the path once at Initialize:

- **Claude Code runtime** (you are running inside Claude Code — the `AskUserQuestion` tool is available to you): **do not** shell out to `np-tools.cjs askuser`. Parse the JSON spec inside each askuser block and call the native `AskUserQuestion` tool directly with one question entry:
  - `type: "select"` → `{ question, header, multiSelect: false, options: [{label, description}...] }`
  - `type: "multiselect"` → `{ question, header, multiSelect: true, options: [{label, description}...] }`
  - `type: "confirm"` → single question with `options: [{label: "Yes"}, {label: "No"}]`, `multiSelect: false`
  - `type: "input"` → ask as a plain free-form question in the chat; the user replies inline
  Use a short `header` (≤12 chars) that labels the category, e.g. `"Discuss"`, `"Scope"`, `"Overwrite?"`. This is the default path and gives the user a real selection menu.

- **`text_mode == true`** (INIT payload): skip every askuser block and render every question inline as a plain-text numbered list; the user replies with the number. This path is opt-in via `.nubos-pilot/config.json` → `workflow.text_mode`.

- **Other runtime with TTY** (Codex, Gemini, …): run the shell `node .nubos-pilot/bin/np-tools.cjs askuser --json '…'` block verbatim.

`text_mode_source` in the INIT payload (`config` / `default`) is informational only — it does not change the routing above.

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
**Routing was decided at Initialize** (see "Askuser routing" section above). This section documents per-prompt validation only.

**Claude Code path (`AskUserQuestion` tool):** the tool guarantees a non-empty selection; no validation needed.

**Shell askuser path (other runtimes with TTY):**
1. If `askuser` exits with structured error `askuser-no-tty` (exit code 1, stderr JSON with `"code":"askuser-no-tty"`), that means the runtime detection missed something; **skip retry** and treat the remainder of the workflow as text-mode (plain-text numbered lists).
2. If the response is empty or whitespace-only (exit 0 but no value), retry the question once with the same parameters.
3. If still empty, present the options as a plain-text numbered list and ask the user to type their choice number.
Never proceed with an empty answer.

**Text-mode (numbered-list path):** user reply must parse as a valid index (1-N) for select/multiselect, `y/n` for confirm, or any non-empty string for input. Re-ask on invalid input.

**Enable text mode** (force the numbered-list path regardless of runtime): set `workflow.text_mode: true` in `.nubos-pilot/config.json`. Useful for remote-control setups or runtimes where neither `AskUserQuestion` nor TTY stdin are reliable.
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

TPL_PATH=$(node .nubos-pilot/bin/np-tools.cjs template-path milestone/CONTEXT)
node -e '
  const { render } = require("./lib/template.cjs");
  const fs = require("node:fs");
  const tpl = fs.readFileSync(process.argv[1], "utf-8");
  const vars = JSON.parse(process.argv[2]);
  process.stdout.write(render(tpl, vars));
' "$TPL_PATH" "$VARS_JSON" > "$CONTEXT_PATH"
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

### Step 6b: Extract + persist Success Criteria (np-sc-extractor)

CONTEXT.md now captures the decisions. Success Criteria in `roadmap.yaml` are still empty for this milestone — downstream `/np:verify-work` reads them from there, so we must persist them now. Spawn the SC-extractor (haiku) to derive observable SCs from goal + requirements + CONTEXT.md + any pre-existing `M<NNN>-ROADMAP.md` / `M<NNN>-META.json` sidecars, and call `update-phase-meta` to write them.

```bash
SC_START=$(node .nubos-pilot/bin/np-tools.cjs metrics start-timestamp)
SC_MODEL=$(node .nubos-pilot/bin/np-tools.cjs resolve-model np-sc-extractor --profile balanced)

REQS_PATH=".nubos-pilot/REQUIREMENTS.md"
[[ -f "$REQS_PATH" ]] || REQS_PATH=".planning/REQUIREMENTS.md"

EXISTING_SC_JSON=$(node -e '
  const r = require("./lib/roadmap.cjs");
  const p = r.getPhase(process.argv[1]);
  process.stdout.write(JSON.stringify(p.success_criteria || []));
' "$PHASE")

# Spawn agent=np-sc-extractor tier=haiku model=$SC_MODEL milestone=$PHASE
#   input: milestone=$PHASE, milestone_id=$MILESTONE_ID, milestone_dir=$MILESTONE_DIR,
#          context_path=$CONTEXT_PATH, requirements_path=$REQS_PATH,
#          existing_success_criteria=$EXISTING_SC_JSON
#   output: calls `np-tools.cjs update-phase-meta $PHASE --stdin` with
#           {"success_criteria": [{id:"SC-N", text:"..."}, ...]} and prints summary.

SC_END=$(node .nubos-pilot/bin/np-tools.cjs metrics end-timestamp)
node .nubos-pilot/bin/np-tools.cjs metrics record \
  --agent np-sc-extractor --tier haiku --resolved-model "$SC_MODEL" \
  --phase "$PHASE" --plan "${MILESTONE_ID}-sc" --task "${MILESTONE_ID}-sc-extract" \
  --started "$SC_START" --ended "$SC_END" \
  --tokens-in "${TOKENS_IN:-0}" --tokens-out "${TOKENS_OUT:-0}" \
  --retry-count 0 --status ok --runtime "$RUNTIME"
```

After the spawn, sanity-check that `success_criteria` is non-empty:

```bash
SC_COUNT=$(node -e '
  const r = require("./lib/roadmap.cjs");
  const p = r.getPhase(process.argv[1]);
  process.stdout.write(String((p.success_criteria || []).length));
' "$PHASE")
if [[ "$SC_COUNT" -lt 1 ]]; then
  echo "ERROR: np-sc-extractor produced no success_criteria for $MILESTONE_ID — refusing to continue." >&2
  exit 1
fi
```

A failure here is loud by design: `/np:verify-work` and `/np:validate-phase` depend on a populated `success_criteria[]`. If the extractor cannot derive any, fix the goal/requirements/CONTEXT.md inputs before retrying.

### Step 7: Commit respecting config.commit_docs

```bash
COMMIT_DOCS=$(node .nubos-pilot/bin/np-tools.cjs config-get workflow.commit_docs 2>/dev/null || echo "true")
if [[ "$COMMIT_DOCS" == "true" ]]; then
  git add "$CONTEXT_PATH" .nubos-pilot/roadmap.yaml .nubos-pilot/ROADMAP.md
  git commit -m "docs($MILESTONE_ID): capture milestone context + success criteria"
fi
```

If `workflow.commit_docs` is false, leave both CONTEXT.md and the roadmap edits uncommitted — the user is opting into manual commit gating.

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
