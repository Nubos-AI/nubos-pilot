<!-- Placeholders: core_value, created_date, first_milestone_name, first_phase_name, primary_constraints, project_name -->
# {{project_name}}

## Project

{{project_name}} — {{core_value}}

## What This Is

{{project_name}} is an early-stage project. Update this section after the first
phase ships with a concrete 2-3 sentence description of what the product does
and who it serves. Use the user's language and framing.

## Core Value

{{core_value}}

If everything else fails, this one sentence must remain true. It drives
prioritization when tradeoffs arise.

## Constraints

{{primary_constraints}}

## Current Focus

Milestone: **{{first_milestone_name}}**
First phase: **{{first_phase_name}}**

This section is updated by `np:next` and milestone transitions. It reflects
what is actively being worked on right now, not the full roadmap (see
`ROADMAP.md`).

## Key Decisions

<!-- Decisions that constrain future work. Add throughout project lifecycle. -->

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Initial scaffold via np:new-project | Greenfield project bootstrap (D-28) | — Pending |

## Evolution

PROJECT.md evolves throughout the project lifecycle.

**After each phase transition:**
1. Requirements invalidated? → Move to Out of Scope in REQUIREMENTS.md with reason
2. Requirements validated? → Move to Validated in REQUIREMENTS.md with phase reference
3. New requirements emerged? → Add to REQUIREMENTS.md Active list
4. Decisions to log? → Add to Key Decisions above
5. "What This Is" still accurate? → Update if drifted

**After each milestone:**
1. Full review of all sections
2. Core Value check — still the right priority?
3. Update Current Focus with next milestone/phase

---
*Created: {{created_date}}*
*Last updated: {{created_date}} after np:new-project*
