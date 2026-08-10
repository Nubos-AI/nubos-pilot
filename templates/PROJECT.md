<!-- Placeholders: core_value, created_date, domain_text, first_milestone_name, first_phase_name, non_goals_text, primary_constraints, project_description, project_name, strategic_decisions_text, success_criteria_text, target_users_text -->
# {{project_name}}

## Project

{{project_name}} — {{core_value}}

## What This Is

{{project_description}}

## Domain

{{domain_text}}

## Target Users

{{target_users_text}}

## Core Value

{{core_value}}

If everything else fails, this one sentence must remain true. It drives
prioritization when tradeoffs arise.

## Non-Goals

{{non_goals_text}}

## Success Criteria

{{success_criteria_text}}

## Strategic Decisions

{{strategic_decisions_text}}

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

**When scope or positioning shifts:**
- Run `np:discuss-project` to refresh Domain, Target Users, Non-Goals,
  Success Criteria, and Strategic Decisions without starting over.

---
*Created: {{created_date}}*
*Last updated: {{created_date}} after np:new-project*
