# Phase Artifact Schemas

Phase-5 defines the canonical on-disk format of the 5 planning artifacts.
Downstream phases (Phase 6 executor, Phase 10 review commands) parse against
these schemas. Breaking changes require a Phase-5 amendment or a new phase.

All artifacts live under `.nubos-pilot/phases/<padded>-<slug>/` — e.g.
`.nubos-pilot/phases/05-planning-workflows-agents/05-CONTEXT.md`.

| Artifact           | Producer                     | Consumer(s)                              | Lifecycle       |
| ------------------ | ---------------------------- | ---------------------------------------- | --------------- |
| `CONTEXT.md`       | `/np:discuss-phase`          | researcher, planner, plan-checker        | rewrite on save |
| `RESEARCH.md`      | `/np:research-phase`         | planner, plan-checker                    | rewrite on save |
| `PLAN.md`          | `/np:plan-phase` planner     | plan-checker, executor, verifier         | rewrite on save |
| `PLAN-REVIEW.md`   | `/np:plan-phase` loop        | user, np:undo, Phase 10 review           | append-only     |
| `QUESTIONS.json`   | `/np:discuss-phase-power`    | power-mode UI, discuss-phase finalize    | rewrite on save |

## CONTEXT.md

Captures user decisions from the adaptive interview. Read by every downstream
agent. Structure:

```markdown
---
phase: "<phase-number>"
padded: "<padded>"
phase_name: "<human-readable>"
mode: adaptive | assumptions | power
finalized: <ISO-8601>
---

# <Phase Name> — Context

<domain>
One-paragraph framing: what user domain is this phase serving?
</domain>

<decisions>
**D-01:** First locked decision (short imperative)
- Rationale: …
- Constraints: …

**D-02:** Next decision …
</decisions>

<canonical_refs>
- path/to/file.ts (why it matters)
- https://… (spec or vendor doc)
</canonical_refs>

<code_context>
- `lib/foo.cjs` — current behavior, what we keep, what we replace
</code_context>

<specifics>
- Concrete inputs/outputs the user insisted on
</specifics>

<deferred>
- Items explicitly parked for a later phase
</deferred>
```

**Required tag blocks:** `<domain>`, `<decisions>`, `<canonical_refs>`,
`<code_context>`, `<specifics>`, `<deferred>`. Tag blocks may be empty but
must be present — downstream agents assume the structure.

**Placeholders** in `templates/CONTEXT.md` (Plan 05-06) use `{{ snake_case }}`;
`lib/template.cjs` fails loud on unknown keys.

## RESEARCH.md

Stack, patterns, pitfalls, security domain, open questions. Produced by
`agents/np-researcher.md` (tier=sonnet). High-level H2 sections — in this order:

```markdown
## Summary
## Standard Stack
## Architecture Patterns
## Don't Hand-Roll
## Pitfalls
## Security Domain
## Validation Architecture
## Assumptions Log
## Open Questions
## Environment Availability
## Research Coverage
## Sources
```

`## Research Coverage` is **mandatory in offline mode** (no WebFetch/MCP) — it
lists which areas were covered from local knowledge only so the planner can
flag gaps. In online mode the section may be empty but the header must be
present.

Each source line in `## Sources` uses:

```
- <absolute path or URL> — <one-line relevance note> — <HIGH|MEDIUM|LOW>
```

## PLAN.md

The executor's prompt. YAML frontmatter + body. One PLAN.md per `NN-NN-PLAN.md`
(phase-scoped — the plan number is the second NN). Produced by
`agents/np-planner.md` (tier=opus), verified by `agents/np-plan-checker.md` (opus).

### Required frontmatter keys

```yaml
---
phase: "<phase-number>"            # string, e.g. "5"
plan: "<phase>-<plan>"             # e.g. "05-01"
plan_id: "<phase>-<plan>"          # stable ID — equal to `plan`
wave: <integer>                    # 1..N — planner-assigned execution wave
depends_on: [<plan_id>, …]         # inter-plan dependencies
files_modified: [<relative-path>]  # every path this plan will touch
autonomous: true | false           # true = no human gate needed mid-execution
requirements: [<REQ-ID>]           # roadmap requirement IDs this plan covers
must_haves:                        # goal-backward truths + artifacts + links
  truths: [string, …]
  artifacts: [{ path, provides }]
  key_links: [{ from, to, via, pattern }]
---
```

### Required body sections

```markdown
<objective>
Single-paragraph statement of intent.
</objective>

<context>
@<path>            # embed CONTEXT.md, RESEARCH.md, sibling plans, libs
<interfaces>
Shape descriptions of APIs this plan touches.
</interfaces>
</context>

<tasks>
<task type="auto" tdd="true|false">
  <name>Task N: …</name>
  <files>…</files>
  <read_first>…</read_first>
  <behavior>…</behavior>
  <action>…</action>
  <verify><automated>…</automated></verify>
  <acceptance_criteria>…</acceptance_criteria>
  <done>…</done>
</task>
</tasks>

<threat_model>
| Threat ID | Category | Component | Disposition | Mitigation |
</threat_model>

<verification>
- Shell command(s) the executor runs after the plan completes.
</verification>

<success_criteria>
- Boolean predicates that must hold after execution.
</success_criteria>

<output>
Path of the SUMMARY.md that the executor writes.
</output>
```

### Optional sections

- `## Task Promotion` — emitted when Plan 05-04's `shouldPromoteToTasks`
  returns `promote: true`. Lists the triggers (`parallelism`, `mixed-tiers`,
  `non-linear-deps`) and the rationale. The presence of this section tells
  the plan-phase workflow to scaffold `tasks/`. See D-18..D-20.

## PLAN-REVIEW.md

**Append-only** audit trail of the plan-checker verification loop. One file
per phase (not per plan). Created by `plan-review-append` verb (Plan 05-10
Task 1). Never truncated, even on abort (D-16, D-17).

Format:

```markdown
# PLAN-REVIEW.md — Phase <N> (<Phase Name>)

Append-only audit trail of plan-checker iterations. Never truncate.

## Iteration 1 - 2026-04-15T14:22:13.412Z

**Planner output:** PLAN.md committed at <sha or 'pending'>
**Checker verdict:** issues_found
**Findings:**

```yaml
status: issues_found
findings:
  - category: missing-success-criterion
    severity: critical
    target: "PLAN.md §SC-3"
    message: "No task addresses SC-3."
```

**Planner response:** revision

## Iteration 2 - 2026-04-15T14:24:41.988Z

**Planner output:** PLAN.md committed at <sha>
**Checker verdict:** passed
**Findings:**

```yaml
status: passed
findings: []
```

**Planner response:** done
```

Invariants:

- Every iteration section begins with `## Iteration <N> - <ISO_TIMESTAMP>`.
- The YAML verdict block is fenced with `yaml` language tag (Plan 05-10
  Open Question 4 resolution).
- Byte-level append-only — pre-existing bytes are a sha256-verified prefix
  of post-append bytes.
- Survives `plan-phase-abort` (Plan 05-10 Task 1) — abort deletes PLAN.md and
  `tasks/` but never touches PLAN-REVIEW.md.

## QUESTIONS.json

Power-mode state file. Produced by `discuss-phase-power` (Plan 05-08).
Single source of truth while power-mode is in progress; CONTEXT.md is a
derived artifact written only on `finalize` (Pitfall 1 guard).

```json
{
  "phase": "5",
  "padded": "05",
  "mode": "power",
  "created": "2026-04-15T10:00:00.000Z",
  "questions": [
    {
      "id": "Q-01",
      "area": "decisions",
      "question": "Should we gate the /np:plan-phase dispatcher …?",
      "answer": "Yes, use the registry pattern.",
      "explain": "Matches the registry invariant established in Phase 4 D-21."
    }
  ],
  "answers_status": "pending"
}
```

Schema:

| Key               | Type      | Notes                                        |
| ----------------- | --------- | -------------------------------------------- |
| `phase`           | string    | Phase number (matches CONTEXT.md frontmatter) |
| `padded`          | string    | Two-digit padded number                      |
| `mode`            | string    | Always `"power"` here                        |
| `created`         | string    | ISO-8601 creation timestamp                  |
| `questions`       | array     | Ordered list of question objects             |
| `answers_status`  | string    | `pending` \| `finalized`                     |

Question object:

| Key        | Type                   | Notes                                                  |
| ---------- | ---------------------- | ------------------------------------------------------ |
| `id`       | string                 | `Q-NN` — stable ID                                     |
| `area`     | enum                   | `domain` \| `decisions` \| `canonical_refs` \| `code_context` \| `specifics` \| `deferred` |
| `question` | string                 | Question text (German or English depending on user)    |
| `answer`   | string \| null         | `null` until the user fills it                         |
| `explain`  | string \| null         | Optional rationale the user adds inline                |

Lifecycle:

- `discuss-phase-power` writes the file on first run and on `refresh`.
- User edits the JSON directly in their editor.
- On `finalize`: workflow reads JSON, flips `answers_status` to `finalized`,
  renders CONTEXT.md, and writes both files atomically.
- CONTEXT.md is **derived** — regenerating QUESTIONS.json always wins.

Downstream consumers:

- `discuss-phase-power` finalize step — only entry point that touches
  CONTEXT.md from power mode.
- Phase 6 `np:undo` — reads QUESTIONS.json to detect mid-interview state
  and warn the user before rolling back.
- Phase 10 review commands — may parse for audit-trail completeness.
